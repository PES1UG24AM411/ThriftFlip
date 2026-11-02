-- 021_price_alert_book_match_percent.sql
-- Price alerts now also find the SAME book when different students typed its name differently
-- ("Computer Networks: Top Down Approach" for "Computer Networking: A Top-Down Approach"), and say how sure they are:
-- the notification shows a match percentage and the student can message the seller from it.
--   * book_match_percent(alert_book, listing_book) gives 0..100: 100 = the same book (same catalogue row, same ISBN or
--     same_book() from migration 019); otherwise it is built from the title words (75%), the authors (15%) and the
--     edition (10%). A title that is clearly different, authors that clearly differ, or a different edition (when both
--     editions are given; 1 is the form's default and counts as "not given") always stay below the limit.
--   * An alert fires from 70% upwards (price_alert_min_match()). The student sees the percentage in the notification
--     and in the alert list, so a 79% match is a hint to check the listing, not a promise.
-- Additive only: one generated column and one new column, new functions, and two functions replaced with the same
-- signature (notify_price_alerts_for_listing, create_price_alert). No row is deleted or changed. Applied migration files are
-- never edited: this is a new file.

-- ---------------------------------------------------------------------------
-- 1. Title words. Short words and "edition" words are ignored; a word is reduced to its first 5 letters so that
--    "network", "networks" and "networking" are the same word.
-- ---------------------------------------------------------------------------
CREATE FUNCTION title_stems(p TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(array_agg(DISTINCT CASE WHEN length(t) >= 5 THEN left(t, 5) ELSE t END ORDER BY CASE WHEN length(t) >= 5 THEN left(t, 5) ELSE t END), '{}')
    FROM regexp_split_to_table(lower(regexp_replace(COALESCE(p, ''), '[^a-zA-Z0-9]+', ' ', 'g')), ' ') AS t
    WHERE t <> '' AND t NOT IN ('a', 'an', 'the', 'of', 'to', 'and', 'in', 'for', 'on', 'with', 'by', 'edition', 'ed')
$$;

-- stored once per book (so a match never needs to split titles again) and searchable
ALTER TABLE book ADD COLUMN title_stems TEXT[] GENERATED ALWAYS AS (title_stems(title)) STORED;
CREATE INDEX idx_book_title_stems ON book USING gin (title_stems);

-- 0..1: half "how much of both titles is shared" (Dice), half "how much of the shorter title is contained" (overlap)
CREATE FUNCTION stems_similarity(p_a TEXT[], p_b TEXT[]) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN COALESCE(cardinality(p_a), 0) = 0 OR COALESCE(cardinality(p_b), 0) = 0 THEN 0::numeric
           ELSE 0.5 * (2.0 * i.n / (cardinality(p_a) + cardinality(p_b))) + 0.5 * (i.n::numeric / LEAST(cardinality(p_a), cardinality(p_b)))
           END
    FROM (SELECT COUNT(*) AS n FROM (SELECT unnest(p_a) INTERSECT SELECT unnest(p_b)) x) i
$$;

-- ---------------------------------------------------------------------------
-- 2. The match percentage
-- ---------------------------------------------------------------------------
CREATE FUNCTION price_alert_min_match() RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$ SELECT 70 $$;

CREATE FUNCTION book_match_percent(p_a INTEGER, p_b INTEGER) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT COALESCE((
        SELECT CASE
            WHEN x.book_id = y.book_id OR (x.isbn IS NOT NULL AND x.isbn = y.isbn) OR same_book(x.book_id, y.book_id) THEN 100
            WHEN x.edition <> y.edition AND x.edition > 1 AND y.edition > 1 THEN LEAST(r.raw, 69)  -- another edition is another textbook
            WHEN c.t < 0.70 THEN LEAST(r.raw, 69)                          -- different title: never reaches the alert limit
            WHEN NOT c.unknown AND NOT c.compatible THEN LEAST(r.raw, 65)  -- same words, clearly different authors
            ELSE LEAST(r.raw, 99)                                          -- 100 is reserved for the same book
        END
        FROM book x
        JOIN book y ON y.book_id = p_b
        CROSS JOIN LATERAL (SELECT stems_similarity(x.title_stems, y.title_stems) AS t,
                                   (norm_text(x.author) IN ('', 'unknownauthor') OR norm_text(y.author) IN ('', 'unknownauthor')) AS unknown,
                                   authors_compatible(x.author, y.author) AS compatible) c
        CROSS JOIN LATERAL (SELECT ROUND(100 * (0.75 * c.t
                                               + 0.15 * (CASE WHEN c.unknown THEN 0.5 WHEN c.compatible THEN 1 ELSE 0 END)
                                               + 0.10 * (CASE WHEN x.edition = y.edition THEN 1
                                                              WHEN x.edition = 1 OR y.edition = 1 THEN 0.5 ELSE 0 END)))::integer AS raw) r
        WHERE x.book_id = p_a), 0)
$$;

-- ---------------------------------------------------------------------------
-- 3. The notice ledger remembers how sure the match was
-- ---------------------------------------------------------------------------
ALTER TABLE price_alert_notice ADD COLUMN match_percent SMALLINT;

-- ---------------------------------------------------------------------------
-- 4. Who is notified about a listing: same rules as 019 (ACTIVE fixed price, price at or below the maximum, good enough
--    condition, active student, not the owner, once per student, listing and price) but the book comparison is now the
--    percentage. A student with several matching alerts gets one notification, for the best match.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_price_alerts_for_listing(p_listing_id INTEGER) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_sent INTEGER;
BEGIN
    WITH l AS (
        SELECT listing_id, seller_id, book_id, title, price, item_condition
        FROM listing
        WHERE listing_id = p_listing_id AND status = 'ACTIVE' AND listing_type = 'FIXED_PRICE' AND book_id IS NOT NULL
    ),
    cand AS (
        SELECT a.alert_id, a.student_id, a.book_id AS alert_book, m.pct
        FROM price_alert a
        JOIN l ON true
        JOIN student s ON s.student_id = a.student_id AND s.status = 'ACTIVE'
        CROSS JOIN LATERAL (SELECT book_match_percent(a.book_id, l.book_id) AS pct) m
        WHERE a.is_active
          AND a.student_id <> l.seller_id
          AND l.price <= a.max_price
          AND m.pct >= price_alert_min_match()
          AND (a.min_condition IS NULL OR condition_rank(l.item_condition) >= condition_rank(a.min_condition))
    ),
    hit AS (
        SELECT DISTINCT ON (student_id) student_id, alert_id, alert_book, pct
        FROM cand ORDER BY student_id, pct DESC, alert_id
    ),
    fresh AS (
        INSERT INTO price_alert_notice (student_id, listing_id, price, match_percent)
        SELECT hit.student_id, l.listing_id, l.price, hit.pct FROM hit CROSS JOIN l
        ON CONFLICT DO NOTHING
        RETURNING student_id
    ),
    touched AS (
        UPDATE price_alert SET triggered_at = now()
        WHERE alert_id IN (SELECT alert_id FROM cand WHERE student_id IN (SELECT student_id FROM fresh))
        RETURNING alert_id
    )
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT f.student_id, 'PRICE_ALERT',
           CASE WHEN hit.pct = 100 THEN 'Price alert' ELSE 'Price alert · ' || hit.pct || '% match' END,
           '"' || l.title || '" is listed for ₹' || l.price || ', within your price limit. '
               || CASE WHEN hit.pct = 100 THEN 'Exact match for your alert "' || ab.title || '".'
                       ELSE hit.pct || '% match with your alert for "' || ab.title || '" (the title is written differently).' END
               || ' Seller: ' || sl.name || '. Use "Message seller" to ask about it.',
           l.listing_id
    FROM fresh f
    JOIN hit ON hit.student_id = f.student_id
    CROSS JOIN l
    JOIN book ab ON ab.book_id = hit.alert_book
    JOIN student sl ON sl.student_id = l.seller_id;
    GET DIAGNOSTICS v_sent = ROW_COUNT;
    RETURN v_sent;
END;
$$;

-- creating an alert tells the student about listings that are ALREADY cheap enough (same function as the trigger)
CREATE OR REPLACE FUNCTION create_price_alert(p_student_id INTEGER, p_book_id INTEGER, p_max_price NUMERIC, p_min_condition TEXT DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_alert INTEGER;
    v_listing INTEGER;
BEGIN
    INSERT INTO price_alert (student_id, book_id, max_price, min_condition)
    VALUES (p_student_id, p_book_id, p_max_price, p_min_condition)
    RETURNING alert_id INTO v_alert;

    FOR v_listing IN
        SELECT l.listing_id FROM listing l
        WHERE l.status = 'ACTIVE' AND l.listing_type = 'FIXED_PRICE' AND l.book_id IS NOT NULL
          AND l.price <= p_max_price AND l.seller_id <> p_student_id
          AND book_match_percent(p_book_id, l.book_id) >= price_alert_min_match()
          AND (p_min_condition IS NULL OR condition_rank(l.item_condition) >= condition_rank(p_min_condition))
        ORDER BY l.listing_id
    LOOP
        PERFORM notify_price_alerts_for_listing(v_listing);
    END LOOP;
    RETURN v_alert;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Catch-up: cheap listings that only match by similar title (and were never announced) are announced now, once.
--    Never fatal: the app announces them on the next change anyway.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    PERFORM catch_up_price_alerts();
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'price alert catch-up skipped: %', SQLERRM;
END $$;
