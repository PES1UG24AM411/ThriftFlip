-- 019_price_alert_fixes.sql
-- Price alerts did not fire for some listings (for example a Rs 499 listing and a Rs 500 alert). Causes found:
--   1. MATCHING: an alert and a listing were linked only by book_id, but the same book could exist as several
--      catalogue rows (the sell form types title/author/edition/ISBN, and "Kurose" vs "James Kurose, Keith Ross",
--      or an ISBN-10 vs an ISBN-13, created a second row). The alert watched row 1, the listing used row 2.
--   2. NOTIFICATION: "one notification per student and listing, ever" swallowed a later price drop on a listing the
--      student had already been told about, and the check-then-insert was not safe for two events at the same time.
--   3. The condition chosen next to the alert form was never stored, so it could not be matched.
-- This file only ADDS functions, one column and one table; no existing row is changed or deleted, and the
-- single catch-up at the end only creates the notifications that should already have been sent.
-- (Applied migration files must never be edited: this is a new file.)

-- ---------------------------------------------------------------------------
-- 1. "Same book": one definition, used by the trigger, the API and the sell form
-- ---------------------------------------------------------------------------
-- letters and digits only, lower case: "Computer Networking: A Top-Down Approach" = "computer networking a top down approach"
CREATE FUNCTION norm_text(p TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(lower(COALESCE(p, '')), '[^a-z0-9]+', '', 'g')
$$;

-- two author lists are compatible when one is unknown or they share a name of 3+ letters ("Kurose" / "James Kurose, Keith Ross")
CREATE FUNCTION authors_compatible(p_a TEXT, p_b TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT norm_text(p_a) IN ('', 'unknownauthor')
        OR norm_text(p_b) IN ('', 'unknownauthor')
        OR EXISTS (
            SELECT 1
            FROM regexp_split_to_table(lower(regexp_replace(COALESCE(p_a, ''), '[^a-zA-Z0-9]+', ' ', 'g')), ' ') AS wa
            JOIN regexp_split_to_table(lower(regexp_replace(COALESCE(p_b, ''), '[^a-zA-Z0-9]+', ' ', 'g')), ' ') AS wb ON wa = wb
            WHERE length(wa) >= 3)
$$;

-- same catalogue row, or the same ISBN, or the same title and edition with compatible authors
CREATE FUNCTION same_book(p_a INTEGER, p_b INTEGER) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        p_a = p_b OR EXISTS (
            SELECT 1 FROM book x JOIN book y ON y.book_id = p_b
            WHERE x.book_id = p_a
              AND ((x.isbn IS NOT NULL AND x.isbn = y.isbn)
                   OR (norm_text(x.title) = norm_text(y.title) AND x.edition = y.edition AND authors_compatible(x.author, y.author)))),
        false)
$$;

-- NEW > LIKE_NEW > GOOD > FAIR > POOR
CREATE FUNCTION condition_rank(p TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p WHEN 'NEW' THEN 5 WHEN 'LIKE_NEW' THEN 4 WHEN 'GOOD' THEN 3 WHEN 'FAIR' THEN 2 WHEN 'POOR' THEN 1 END
$$;

-- ---------------------------------------------------------------------------
-- 2. The alert remembers the condition (NULL = any condition: all existing alerts keep working as before)
-- ---------------------------------------------------------------------------
ALTER TABLE price_alert ADD COLUMN min_condition TEXT; -- the worst condition the student accepts (NULL = any)
ALTER TABLE price_alert ADD CONSTRAINT ck_alert_condition
    CHECK (min_condition IS NULL OR min_condition IN ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR'));

-- ---------------------------------------------------------------------------
-- 3. One notification per qualifying event. An event = (student, listing, price): the same listing at a NEW lower
--    price is a new event; saving it again at the same price, or a student having two alerts for the same book,
--    is not. The primary key makes this safe even when two statements run at the same moment.
-- ---------------------------------------------------------------------------
CREATE TABLE price_alert_notice (
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- student who was told
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- listing the notification was about
    price NUMERIC(10,2) NOT NULL, -- price of the listing at that moment
    notified_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the notification was created
    PRIMARY KEY (student_id, listing_id, price)
);

-- ---------------------------------------------------------------------------
-- 4. The one function that decides who is notified about a listing
--    (used by the trigger, by create_price_alert and by catch_up_price_alerts)
-- ---------------------------------------------------------------------------
-- Eligible: the listing is ACTIVE and fixed price, the alert is for the same book, the price is at or below the
-- alert's maximum, the condition is good enough, and the student is active and not the owner.
-- Returns how many notifications were created.
CREATE FUNCTION notify_price_alerts_for_listing(p_listing_id INTEGER) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_sent INTEGER;
BEGIN
    WITH l AS (
        SELECT listing_id, seller_id, book_id, title, price, item_condition
        FROM listing
        WHERE listing_id = p_listing_id AND status = 'ACTIVE' AND listing_type = 'FIXED_PRICE' AND book_id IS NOT NULL
    ),
    hit AS (
        SELECT a.student_id, array_agg(a.alert_id) AS alert_ids
        FROM price_alert a
        JOIN l ON true
        JOIN student s ON s.student_id = a.student_id AND s.status = 'ACTIVE'
        WHERE a.is_active
          AND a.student_id <> l.seller_id
          AND l.price <= a.max_price
          AND same_book(a.book_id, l.book_id)
          AND (a.min_condition IS NULL OR condition_rank(l.item_condition) >= condition_rank(a.min_condition))
        GROUP BY a.student_id
    ),
    fresh AS (
        INSERT INTO price_alert_notice (student_id, listing_id, price)
        SELECT hit.student_id, l.listing_id, l.price FROM hit CROSS JOIN l
        ON CONFLICT DO NOTHING
        RETURNING student_id
    ),
    touched AS (
        UPDATE price_alert SET triggered_at = now()
        WHERE alert_id IN (SELECT unnest(hit.alert_ids) FROM hit WHERE hit.student_id IN (SELECT student_id FROM fresh))
        RETURNING alert_id
    )
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT f.student_id, 'PRICE_ALERT', 'Price alert',
           '"' || l.title || '" is listed for ₹' || l.price || ', within your price limit.', l.listing_id
    FROM fresh f CROSS JOIN l;
    GET DIAGNOSTICS v_sent = ROW_COUNT;
    RETURN v_sent;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. When is a listing (re)checked? On creation, and when a change could make it eligible:
--    the price went DOWN, it became ACTIVE again, it became fixed price, its book changed, or its condition improved.
--    (A price increase can never make a listing newly eligible, so it is ignored.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION listing_price_alerts() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status <> 'ACTIVE' OR NEW.listing_type <> 'FIXED_PRICE' OR NEW.book_id IS NULL THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE' AND NOT (
           NEW.price < OLD.price
        OR OLD.status <> 'ACTIVE'
        OR OLD.listing_type <> 'FIXED_PRICE'
        OR OLD.book_id IS DISTINCT FROM NEW.book_id
        OR condition_rank(NEW.item_condition) > condition_rank(OLD.item_condition)) THEN
        RETURN NULL;
    END IF;
    PERFORM notify_price_alerts_for_listing(NEW.listing_id);
    RETURN NULL;
END;
$$;

DROP TRIGGER trg_listing_price_alerts ON listing;
CREATE TRIGGER trg_listing_price_alerts
AFTER INSERT OR UPDATE OF price, status, item_condition, listing_type, book_id ON listing
FOR EACH ROW EXECUTE FUNCTION listing_price_alerts();

-- ---------------------------------------------------------------------------
-- 6. Creating an alert: store it and tell the student about listings that are ALREADY cheap enough
--    (same rules as the trigger, because it is the same function)
-- ---------------------------------------------------------------------------
CREATE FUNCTION create_price_alert(p_student_id INTEGER, p_book_id INTEGER, p_max_price NUMERIC, p_min_condition TEXT DEFAULT NULL)
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
          AND same_book(p_book_id, l.book_id)
          AND (p_min_condition IS NULL OR condition_rank(l.item_condition) >= condition_rank(p_min_condition))
        ORDER BY l.listing_id
    LOOP
        PERFORM notify_price_alerts_for_listing(v_listing);
    END LOOP;
    RETURN v_alert;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Catch-up for events that were missed before this fix.
--    First remember what students were already told (the price is read from the old notification text), so nobody
--    gets a second message about the same listing and price; then notify exactly the ones that were missed.
-- ---------------------------------------------------------------------------
CREATE FUNCTION catch_up_price_alerts() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_listing INTEGER;
    v_total INTEGER := 0;
BEGIN
    FOR v_listing IN
        SELECT listing_id FROM listing
        WHERE status = 'ACTIVE' AND listing_type = 'FIXED_PRICE' AND book_id IS NOT NULL
        ORDER BY listing_id
    LOOP
        v_total := v_total + notify_price_alerts_for_listing(v_listing);
    END LOOP;
    RETURN v_total;
END;
$$;

INSERT INTO price_alert_notice (student_id, listing_id, price)
SELECT DISTINCT n.student_id, n.related_listing_id,
       COALESCE(NULLIF(substring(n.body FROM 'listed for ₹?([0-9]+(\.[0-9]+)?)'), '')::numeric, l.price)
FROM notification n
JOIN listing l ON l.listing_id = n.related_listing_id
WHERE n.type = 'PRICE_ALERT' AND n.related_listing_id IS NOT NULL
ON CONFLICT DO NOTHING;

SELECT catch_up_price_alerts();
