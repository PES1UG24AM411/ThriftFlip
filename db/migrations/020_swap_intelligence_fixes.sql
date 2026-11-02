-- 020_swap_intelligence_fixes.sql
-- Swap Intelligence did not find swap circles (A -> B -> C -> A) that students had configured correctly.
-- Diagnosis (reproduced on a scratch database; the graph walk itself was fine):
--   * The walk, the start order, the "reserved / sold / swapped listing" filter and the preferences saved in
--     swap_preference / student_wanted_book all worked: three students with one catalogue row per book were found
--     from every starting student.
--   * MATCHING, wrong key: an edge A -> B was created only when wanted.book_id = listing.book_id. The same book often
--     exists as several catalogue rows (different ISBN, spelling, "Kurose" vs "James Kurose, Keith Ross"), so a
--     student who picked row 1 as the wanted book never matched a listing that uses row 2. (Same cause as the
--     price-alert bug fixed in 019; the same_book() rule is reused here.)
--   * MATCHING, ignored data: books a seller TYPED as "wanted" (listing_wanted_book.custom_title) were stored but never
--     read by find_swap_cycles, so a circle that depended on one of them could never be found.
--   * NOTIFICATIONS: the ledger key was the list of listing ids, so a second copy of the same book gave the same
--     students another notification for the same swap, and the text did not say who gives what to whom.
-- This file only ADDS functions and replaces two functions (find_swap_cycles, notify_swap_matches) with the same
-- signature; no row is changed or deleted. Applied migration files are never edited: this is a new file.

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------
-- index for "same title" lookups (norm_text is IMMUTABLE); without it every comparison scans the whole catalogue
CREATE INDEX idx_book_norm_title ON book (norm_text(title));

-- the lowest catalogue id among the rows that are "the same book" (same rule as same_book(), migration 019)
CREATE FUNCTION canon_book(p_book INTEGER) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
    SELECT MIN(c.book_id) FROM (
        SELECT p_book AS book_id
        UNION
        SELECT y.book_id FROM book x JOIN book y ON y.isbn = x.isbn
        WHERE x.book_id = p_book AND x.isbn IS NOT NULL
        UNION
        SELECT y.book_id FROM book x
        JOIN book y ON norm_text(y.title) = norm_text(x.title) AND y.edition = x.edition AND authors_compatible(x.author, y.author)
        WHERE x.book_id = p_book
    ) c
$$;

-- Identity of a swap circle for notification purposes: who gives which BOOK to whom, starting at the student with the
-- smallest id (so every student computes the same key). Two copies of the same book give the same key.
CREATE FUNCTION swap_ring_key(p_listing_ids INTEGER[]) RETURNS TEXT
LANGUAGE sql STABLE AS $$
    WITH p AS (
        SELECT u.pos, l.seller_id AS student,
               COALESCE(canon_book(l.book_id)::text, 'l' || l.listing_id) AS book
        FROM unnest(p_listing_ids) WITH ORDINALITY AS u(id, pos)
        JOIN listing l ON l.listing_id = u.id
    ),
    n AS (SELECT COUNT(*)::int AS n FROM p),
    m AS (SELECT pos FROM p ORDER BY student LIMIT 1)
    SELECT string_agg(p.student || ':' || p.book, '-' ORDER BY ((p.pos - m.pos + n.n) % n.n))
    FROM p CROSS JOIN m CROSS JOIN n
$$;

-- ---------------------------------------------------------------------------
-- 2. find_swap_cycles: same result shape, correct matching
--    node = an ACTIVE, swap-enabled, fixed-price listing that is not in an open swap (so reserved, sold, swapped,
--           removed listings and listings already in a request or proposal are never part of a match)
--    edge = listing A -> listing B when the owner of A wants the book of B. "Wants" comes from
--             - swap_preference            (one listing, a catalogue book)
--             - student_wanted_book        (all of the student's listings, a catalogue book)
--             - listing_wanted_book typed  (one listing, a typed title; compared with the title of the other listing)
--           and "the book of B" means the same catalogue row OR a row that same_book() treats as the same book.
-- ---------------------------------------------------------------------------
-- Performance notes: typed titles are a separate small CTE joined with hash joins (a nested loop over all wants per listing
-- was 100x slower), JIT is switched off for these short queries (compiling cost more than running), and when one student is
-- asked for, the walk starts at THAT student's listings instead of walking the whole campus and filtering afterwards.
-- Every cycle is reported once, starting at its smallest listing id, whoever asked.
CREATE OR REPLACE FUNCTION find_swap_cycles(p_student_id INTEGER DEFAULT NULL, p_max_length INTEGER DEFAULT 4)
RETURNS TABLE (swap_type TEXT, cycle_length INTEGER, listing_ids INTEGER[], student_ids INTEGER[])
LANGUAGE sql STABLE SET jit = off AS $$
    WITH RECURSIVE open_listing AS (
        SELECT l.listing_id, l.book_id, l.seller_id,
               norm_text(l.title) AS title_key, norm_text(b.title) AS book_title_key
        FROM listing l LEFT JOIN book b ON b.book_id = l.book_id
        WHERE l.status = 'ACTIVE' AND l.open_to_swap AND l.listing_type = 'FIXED_PRICE'
          AND NOT EXISTS (SELECT 1 FROM swap_request r WHERE r.status IN ('PENDING', 'ACCEPTED')
                            AND l.listing_id IN (r.offered_listing_id, r.requested_listing_id))
          AND NOT EXISTS (SELECT 1 FROM swap_proposal p WHERE p.status IN ('PENDING', 'ACCEPTED')
                            AND l.listing_id IN (p.offered_listing_id, p.requested_listing_id))
    ),
    wants AS (
        SELECT offered_listing_id AS listing_id, wanted_book_id AS book_id FROM swap_preference
        UNION
        SELECT l.listing_id, w.book_id
        FROM student_wanted_book w JOIN listing l ON l.seller_id = w.student_id
    ),
    typed_wants AS (
        SELECT w.listing_id, norm_text(w.custom_title) AS title_key
        FROM listing_wanted_book w
        WHERE w.custom_title IS NOT NULL AND norm_text(w.custom_title) <> ''
    ),
    rel AS (
        SELECT book_id FROM open_listing WHERE book_id IS NOT NULL
        UNION
        SELECT book_id FROM wants
    ),
    -- pairs of catalogue rows that are the same book (same rule as same_book(), computed once for all rows)
    book_pair AS (
        SELECT book_id AS a, book_id AS b FROM rel
        UNION
        SELECT x.book_id, y.book_id
        FROM book x JOIN book y ON x.isbn = y.isbn AND x.book_id <> y.book_id
        WHERE x.book_id IN (SELECT book_id FROM rel) AND y.book_id IN (SELECT book_id FROM rel)
        UNION
        SELECT x.book_id, y.book_id
        FROM book x JOIN book y ON norm_text(x.title) = norm_text(y.title) AND x.edition = y.edition AND x.book_id <> y.book_id
        WHERE x.book_id IN (SELECT book_id FROM rel) AND y.book_id IN (SELECT book_id FROM rel)
          AND authors_compatible(x.author, y.author)
    ),
    edges AS (
        SELECT la.listing_id AS from_id, la.seller_id AS from_student, lb.listing_id AS to_id, lb.seller_id AS to_student
        FROM wants w
        JOIN open_listing la ON la.listing_id = w.listing_id
        JOIN book_pair bp ON bp.a = w.book_id
        JOIN open_listing lb ON lb.book_id = bp.b
        WHERE la.seller_id <> lb.seller_id
        UNION
        SELECT la.listing_id, la.seller_id, lb.listing_id, lb.seller_id
        FROM typed_wants t
        JOIN open_listing la ON la.listing_id = t.listing_id
        JOIN open_listing lb ON lb.title_key = t.title_key
        WHERE la.seller_id <> lb.seller_id
        UNION
        SELECT la.listing_id, la.seller_id, lb.listing_id, lb.seller_id
        FROM typed_wants t
        JOIN open_listing la ON la.listing_id = t.listing_id
        JOIN open_listing lb ON lb.book_title_key = t.title_key
        WHERE la.seller_id <> lb.seller_id
    ),
    walk (start_id, current_id, path, students, len) AS (
        SELECT e.from_id, e.to_id, ARRAY[e.from_id, e.to_id], ARRAY[e.from_student, e.to_student], 2
        FROM edges e
        WHERE (p_student_id IS NULL AND e.to_id > e.from_id)   -- whole campus: every cycle once, from its smallest listing
           OR e.from_student = p_student_id                    -- one student: only cycles through that student's listings
        UNION ALL
        SELECT w.start_id, e.to_id, w.path || e.to_id, w.students || e.to_student, w.len + 1
        FROM walk w
        JOIN edges e ON e.from_id = w.current_id
        WHERE (p_student_id IS NOT NULL OR e.to_id > w.start_id)
          AND NOT (e.to_id = ANY (w.path))
          AND NOT (e.to_student = ANY (w.students))
          AND w.len < p_max_length
    ),
    found AS (
        SELECT w.len, w.path, w.students,
               array_position(w.path, (SELECT MIN(x) FROM unnest(w.path) AS x)) AS p
        FROM walk w
        JOIN edges closing ON closing.from_id = w.current_id AND closing.to_id = w.start_id
        WHERE p_student_id IS NULL OR p_student_id = ANY (w.students)
    )
    SELECT CASE WHEN f.len = 2 THEN 'DIRECT' ELSE 'MULTI_WAY' END,
           f.len,
           f.path[f.p:f.len] || f.path[1:f.p - 1],         -- rotate so the smallest listing id comes first
           f.students[f.p:f.len] || f.students[1:f.p - 1]
    FROM found f
    ORDER BY f.len, 3;
$$;

-- ---------------------------------------------------------------------------
-- 3. Suggestions for the screen: one entry per circle (copies of the same book from the same student are counted as
--    "alternatives" instead of being listed as separate matches)
-- ---------------------------------------------------------------------------
CREATE FUNCTION swap_match_suggestions(p_student_id INTEGER DEFAULT NULL)
RETURNS TABLE (swap_type TEXT, cycle_length INTEGER, listing_ids INTEGER[], student_ids INTEGER[], ring_key TEXT, alternatives INTEGER)
LANGUAGE sql STABLE SET jit = off AS $$
    SELECT s.swap_type, s.cycle_length, s.listing_ids, s.student_ids, s.ring_key, s.alternatives
    FROM (
        SELECT c.swap_type, c.cycle_length, c.listing_ids, c.student_ids, k.ring_key,
               ROW_NUMBER() OVER (PARTITION BY k.ring_key ORDER BY c.listing_ids) AS rn,
               (COUNT(*) OVER (PARTITION BY k.ring_key))::int - 1 AS alternatives
        FROM find_swap_cycles(p_student_id, 3) c
        CROSS JOIN LATERAL (SELECT swap_ring_key(c.listing_ids) AS ring_key) k
    ) s
    WHERE s.rn = 1
    ORDER BY s.cycle_length, s.listing_ids
$$;

-- ---------------------------------------------------------------------------
-- 4. notify_swap_matches: every student of a current circle who has not been told about THIS circle (same students,
--    same books) gets ONE notification that says what they give, to whom, and what they get from whom.
--    It only informs: no swap is proposed or completed. Returns how many notifications were created.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_swap_matches() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_count INTEGER;
BEGIN
    WITH members AS (
        SELECT s.ring_key, s.cycle_length AS n, s.listing_ids, u.student_id, u.pos::INTEGER AS pos
        FROM swap_match_suggestions(NULL) s
        CROSS JOIN LATERAL unnest(s.student_ids) WITH ORDINALITY AS u(student_id, pos)
    ),
    fresh AS (
        INSERT INTO swap_match_notice (student_id, cycle_key)
        SELECT m.student_id, m.ring_key FROM members m
        JOIN student st ON st.student_id = m.student_id AND st.status = 'ACTIVE'
        ON CONFLICT DO NOTHING
        RETURNING student_id, cycle_key
    ),
    sent AS (
        INSERT INTO notification (student_id, type, title, body, related_listing_id)
        SELECT m.student_id, 'SWAP_MATCH',
               CASE WHEN m.n = 2 THEN 'Swap match found' ELSE 'Three-way swap match found' END,
               'You give "' || own.title || '" to ' || taker.name || ' and get "' || got.title || '" from ' || giver.name
                   || '. Open Swaps to see the match, message the others or propose the swap. Nothing happens until everybody agrees.',
               own.listing_id
        FROM fresh f
        JOIN members m ON m.student_id = f.student_id AND m.ring_key = f.cycle_key
        JOIN listing own ON own.listing_id = m.listing_ids[m.pos]
        JOIN listing got ON got.listing_id = m.listing_ids[(m.pos % m.n) + 1]                 -- the book I receive
        JOIN student giver ON giver.student_id = got.seller_id
        JOIN listing prev ON prev.listing_id = m.listing_ids[((m.pos - 2 + m.n) % m.n) + 1]   -- its owner receives mine
        JOIN student taker ON taker.student_id = prev.seller_id
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_count FROM sent;
    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Nobody is told twice about a match they were already told about under the old ledger key
-- ---------------------------------------------------------------------------
INSERT INTO swap_match_notice (student_id, cycle_key)
SELECT student_id, new_key
FROM (
    SELECT n.student_id,
           CASE WHEN n.cycle_key ~ '^[0-9]+(-[0-9]+)+$'
                THEN swap_ring_key(string_to_array(n.cycle_key, '-')::INTEGER[]) END AS new_key
    FROM swap_match_notice n
) old
WHERE new_key IS NOT NULL
ON CONFLICT DO NOTHING;

-- Catch-up: circles that already exist but were never found before this fix are announced now (once).
DO $$
BEGIN
    PERFORM notify_swap_matches();
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'swap match catch-up skipped: %', SQLERRM; -- never block the migration; the app announces matches on the next change
END $$;
