-- 014_fixes.sql
-- Fixes found by the test suite. Applied files 010-013 are NOT edited; this file corrects them so that a fresh
-- database and an already migrated one end up identical.
--
-- 1. v_student_reputation returned its counts as BIGINT, which the pg driver hands to JavaScript as STRINGS ("1" !== 1).
--    The counts are now INTEGER. A view column type cannot be changed with CREATE OR REPLACE, so the view and its only
--    dependent view (v_listing_details) are dropped and created again with the same definitions.
-- 2. propose_swap: (a) offering a book you do not own is reported as such before the "swap with yourself" check
--    (the more specific rule wins); (b) a settlement above 0 with NO payer slipped through, because
--    "NULL NOT IN (...)" is NULL, not true.
-- 3. A PENDING swap proposal is closed (and both students told) as soon as one of its books is sold, removed, reserved
--    or no longer open to swapping; before, it stayed PENDING until somebody tried to accept it.
-- 4. recommend_listings: reason labels keep their original meaning: "Similar to your favorites" for anything related to
--    the wishlist, "Related to your activity" for searches/views/purchases.

DROP VIEW v_listing_details;
DROP VIEW v_student_reputation;

CREATE VIEW v_student_reputation AS
WITH released AS (
    SELECT t.transaction_id, t.buyer_id, t.seller_id, t.transaction_type,
           COALESCE('C' || sr.cycle_id::text, 'P' || t.swap_proposal_id::text, 'T' || t.transaction_id::text) AS deal_key,
           (t.transaction_type = 'SWAP') AS is_swap
    FROM transactions t
    LEFT JOIN swap_request sr ON sr.swap_request_id = t.swap_request_id
    WHERE t.state = 'RELEASED'
      -- a multi-way cycle only counts when EVERY transaction of the cycle is released
      AND NOT EXISTS (SELECT 1 FROM swap_request sr2
                      JOIN transactions t2 ON t2.swap_request_id = sr2.swap_request_id
                      WHERE sr.cycle_id IS NOT NULL AND sr2.cycle_id = sr.cycle_id AND t2.state <> 'RELEASED')
),
deals AS (
    SELECT DISTINCT student_id, deal_key, is_swap
    FROM (SELECT buyer_id AS student_id, deal_key, is_swap FROM released
          UNION ALL
          SELECT seller_id, deal_key, is_swap FROM released) x
),
deal_counts AS (
    SELECT student_id,
           COUNT(*) FILTER (WHERE NOT is_swap) AS completed_sales,
           COUNT(*) FILTER (WHERE is_swap) AS completed_swaps
    FROM deals GROUP BY student_id
),
ratings AS (
    SELECT r.ratee_id, AVG(r.score) AS avg_rating, COUNT(*) AS rating_count
    FROM rating r
    JOIN transactions t ON t.transaction_id = r.transaction_id AND t.state = 'RELEASED'
    GROUP BY r.ratee_id
)
SELECT
    s.student_id,
    s.name,
    COALESCE(r.rating_count, 0)::INTEGER AS rating_count,
    ROUND(r.avg_rating, 2) AS avg_rating,
    COALESCE(d.completed_sales, 0)::INTEGER AS completed_sales,
    COALESCE(d.completed_swaps, 0)::INTEGER AS completed_swaps,
    COALESCE(rp.upheld_reports, 0)::INTEGER AS upheld_reports,
    CASE WHEN COALESCE(d.completed_sales, 0) + COALESCE(d.completed_swaps, 0) = 0 THEN 0
         ELSE GREATEST(0, LEAST(100, ROUND(
              5 * LEAST(COALESCE(d.completed_sales, 0) + COALESCE(d.completed_swaps, 0), 10)
            + 10 * COALESCE(r.avg_rating, 0) * LEAST(COALESCE(r.rating_count, 0), 5) / 5.0
            - 10 * COALESCE(rp.upheld_reports, 0))))::INTEGER
    END AS reputation_score,
    (COALESCE(d.completed_sales, 0) + COALESCE(d.completed_swaps, 0))::INTEGER AS completed_transactions
FROM student s
LEFT JOIN ratings r ON r.ratee_id = s.student_id
LEFT JOIN deal_counts d ON d.student_id = s.student_id
LEFT JOIN (
    SELECT reported_student_id, COUNT(*) AS upheld_reports
    FROM report
    WHERE status IN ('WARNED', 'LISTING_REMOVED', 'USER_SUSPENDED')
    GROUP BY reported_student_id
) rp ON rp.reported_student_id = s.student_id;

CREATE VIEW v_listing_details AS
SELECT
    l.listing_id, l.title, l.description, l.category, l.item_condition, l.listing_type,
    l.price, l.status, l.open_to_swap, l.created_at,
    l.seller_id, s.name AS seller_name, rep.reputation_score AS seller_reputation,
    l.campus_id, c.name AS campus_name,
    b.book_id, b.isbn, b.author, b.edition, b.subject,
    co.course_id, co.code AS course_code, co.name AS course_name,
    a.auction_id, a.end_time AS auction_end_time,
    COALESCE(a.current_price, l.price) AS current_price,
    dep.department_id AS department_id, dep.name AS department_name, co.semester AS course_semester,
    (SELECT li.image_id FROM listing_image li WHERE li.listing_id = l.listing_id ORDER BY li.position, li.image_id LIMIT 1) AS cover_image_id,
    (SELECT COUNT(*) FROM wishlist w WHERE w.listing_id = l.listing_id) AS wishlist_count
FROM listing l
JOIN student s ON s.student_id = l.seller_id
JOIN campus c ON c.campus_id = l.campus_id
JOIN v_student_reputation rep ON rep.student_id = l.seller_id
LEFT JOIN book b ON b.book_id = l.book_id
LEFT JOIN course co ON co.course_id = b.course_id
LEFT JOIN department dep ON dep.department_id = co.department_id
LEFT JOIN auction a ON a.listing_id = l.listing_id;

CREATE OR REPLACE FUNCTION propose_swap(
    p_proposer_id INTEGER, p_offered_listing_id INTEGER, p_requested_listing_id INTEGER,
    p_settlement NUMERIC DEFAULT 0, p_payer TEXT DEFAULT NULL, p_message TEXT DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_off listing%ROWTYPE;
    v_req listing%ROWTYPE;
    v_id INTEGER;
    v_amount NUMERIC := COALESCE(p_settlement, 0);
BEGIN
    IF p_offered_listing_id = p_requested_listing_id THEN
        RAISE EXCEPTION 'Choose a different book to offer' USING ERRCODE = 'check_violation';
    END IF;
    -- lock both listings in a fixed order so two simultaneous proposals cannot deadlock
    PERFORM 1 FROM listing WHERE listing_id IN (p_offered_listing_id, p_requested_listing_id) ORDER BY listing_id FOR UPDATE;
    SELECT * INTO v_off FROM listing WHERE listing_id = p_offered_listing_id;
    SELECT * INTO v_req FROM listing WHERE listing_id = p_requested_listing_id;
    IF v_off.listing_id IS NULL OR v_req.listing_id IS NULL THEN
        RAISE EXCEPTION 'Listing not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF (SELECT status FROM student WHERE student_id = p_proposer_id) IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'Only active students can propose swaps' USING ERRCODE = 'check_violation';
    END IF;
    IF v_off.seller_id <> p_proposer_id THEN
        RAISE EXCEPTION 'You can only offer a book that you own' USING ERRCODE = 'check_violation';
    END IF;
    IF v_req.seller_id = p_proposer_id THEN
        RAISE EXCEPTION 'You cannot swap with yourself' USING ERRCODE = 'check_violation';
    END IF;
    IF v_req.listing_type <> 'FIXED_PRICE' OR NOT v_req.open_to_swap THEN
        RAISE EXCEPTION 'The owner has not made this listing available for swapping' USING ERRCODE = 'check_violation';
    END IF;
    IF v_req.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'The listing you want is no longer available' USING ERRCODE = 'check_violation';
    END IF;
    IF v_off.listing_type <> 'FIXED_PRICE' OR v_off.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'The book you offer must be an active fixed-price listing' USING ERRCODE = 'check_violation';
    END IF;
    IF v_amount < 0 OR v_amount > 100000 THEN
        RAISE EXCEPTION 'The settlement amount must be between 0 and 100000' USING ERRCODE = 'check_violation';
    END IF;
    IF v_amount > 0 AND (p_payer IS NULL OR p_payer NOT IN ('PROPOSER', 'RECEIVER')) THEN
        RAISE EXCEPTION 'Say who pays the settlement amount' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM swap_proposal WHERE offered_listing_id = p_offered_listing_id
                 AND requested_listing_id = p_requested_listing_id AND status IN ('PENDING', 'ACCEPTED')) THEN
        RAISE EXCEPTION 'You already proposed this swap' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO swap_proposal (proposer_id, receiver_id, offered_listing_id, requested_listing_id,
                               settlement_amount, settlement_payer, message)
    VALUES (p_proposer_id, v_req.seller_id, p_offered_listing_id, p_requested_listing_id,
            v_amount, CASE WHEN v_amount > 0 THEN p_payer ELSE NULL END, NULLIF(btrim(COALESCE(p_message, '')), ''))
    RETURNING swap_proposal_id INTO v_id;

    PERFORM tf_notify(v_req.seller_id, 'SWAP_PROPOSAL', 'New swap proposal',
        'Someone offers "' || v_off.title || '" for your "' || v_req.title || '".', p_requested_listing_id);
    RETURN v_id;
END;
$$;

CREATE FUNCTION close_stale_swap_proposals() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_p RECORD;
BEGIN
    FOR v_p IN
        SELECT swap_proposal_id, proposer_id, receiver_id, offered_listing_id
        FROM swap_proposal
        WHERE status = 'PENDING'
          AND ((offered_listing_id = NEW.listing_id AND NEW.status <> 'ACTIVE')
            OR (requested_listing_id = NEW.listing_id AND (NEW.status <> 'ACTIVE' OR NOT NEW.open_to_swap)))
        ORDER BY swap_proposal_id
        FOR UPDATE
    LOOP
        UPDATE swap_proposal SET status = 'CANCELLED', responded_at = now(), updated_at = now() WHERE swap_proposal_id = v_p.swap_proposal_id;
        PERFORM tf_notify(v_p.proposer_id, 'SWAP_UPDATE', 'Swap proposal closed',
            'A book in your swap proposal is no longer available for swapping.', NULL);
        IF v_p.receiver_id IS NOT NULL AND NEW.listing_id = v_p.offered_listing_id THEN
            PERFORM tf_notify(v_p.receiver_id, 'SWAP_UPDATE', 'Swap proposal closed',
                'A swap proposal for your book was withdrawn because the offered book is no longer available.', NULL);
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_listing_close_swap_proposals
AFTER UPDATE OF status, open_to_swap ON listing
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.open_to_swap IS DISTINCT FROM NEW.open_to_swap)
EXECUTE FUNCTION close_stale_swap_proposals();

CREATE OR REPLACE FUNCTION recommend_listings(p_student_id INTEGER, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (listing_id INTEGER, title TEXT, price NUMERIC, score DOUBLE PRECISION, reason TEXT)
LANGUAGE sql STABLE AS $$
    WITH me AS (
        SELECT student_id, department_id, semester, campus_id FROM student WHERE student_id = p_student_id
    ),
    taste AS (
        SELECT AVG(e.embedding) AS v
        FROM wishlist w JOIN listing_embedding e ON e.listing_id = w.listing_id
        WHERE w.student_id = p_student_id
    ),
    wish AS (
        SELECT l.book_id, b.subject, b.course_id
        FROM wishlist w JOIN listing l ON l.listing_id = w.listing_id LEFT JOIN book b ON b.book_id = l.book_id
        WHERE w.student_id = p_student_id
    ),
    recent AS (
        SELECT sa.book_id, sa.course_id FROM search_activity sa
        WHERE sa.student_id = p_student_id AND sa.searched_at >= now() - INTERVAL '30 days'
    ),
    bought AS (
        SELECT DISTINCT pb.subject
        FROM transactions tx JOIN listing pl ON pl.listing_id = tx.listing_id JOIN book pb ON pb.book_id = pl.book_id
        WHERE tx.buyer_id = p_student_id AND tx.state = 'RELEASED'
    ),
    cand AS (
        SELECT l.listing_id, l.title, l.price, l.created_at, l.category, l.campus_id,
               (co.department_id = me.department_id) AS dept_match,
               (co.department_id = me.department_id AND co.semester = me.semester) AS sem_match,
               EXISTS (SELECT 1 FROM wish w WHERE w.book_id IS NOT NULL AND w.book_id = l.book_id) AS wish_book,
               EXISTS (SELECT 1 FROM wish w WHERE w.course_id IS NOT NULL AND w.course_id = b.course_id) AS wish_course,
               EXISTS (SELECT 1 FROM wish w WHERE w.subject IS NOT NULL AND w.subject = b.subject) AS wish_subject,
               EXISTS (SELECT 1 FROM recent r WHERE r.book_id IS NOT NULL AND r.book_id = l.book_id) AS recent_book,
               EXISTS (SELECT 1 FROM recent r WHERE r.course_id IS NOT NULL AND r.course_id = b.course_id) AS recent_course,
               EXISTS (SELECT 1 FROM bought x WHERE x.subject = b.subject) AS bought_subject,
               (me.campus_id = l.campus_id) AS same_campus,
               CASE WHEN t.v IS NOT NULL AND e.embedding IS NOT NULL THEN GREATEST(0, 1 - (e.embedding <=> t.v)) ELSE 0 END AS sim,
               (t.v IS NOT NULL AND e.embedding IS NOT NULL) AS has_sim
        FROM listing l
        CROSS JOIN me
        CROSS JOIN taste t
        LEFT JOIN listing_embedding e ON e.listing_id = l.listing_id
        LEFT JOIN book b ON b.book_id = l.book_id
        LEFT JOIN course co ON co.course_id = b.course_id
        WHERE l.status = 'ACTIVE'
          AND l.seller_id <> me.student_id
          AND NOT EXISTS (SELECT 1 FROM wishlist w WHERE w.student_id = me.student_id AND w.listing_id = l.listing_id)
    )
    SELECT c.listing_id, c.title, c.price,
           (  CASE WHEN c.dept_match THEN 30 ELSE 0 END + CASE WHEN c.sem_match THEN 20 ELSE 0 END
            + CASE WHEN c.wish_book THEN 25 ELSE 0 END + CASE WHEN c.wish_course THEN 10 ELSE 0 END
            + CASE WHEN c.wish_subject THEN 8 ELSE 0 END
            + CASE WHEN c.recent_book THEN 20 ELSE 0 END + CASE WHEN c.recent_course THEN 10 ELSE 0 END
            + CASE WHEN c.bought_subject THEN 10 ELSE 0 END
            + 20 * c.sim
            + CASE WHEN c.same_campus THEN 8 ELSE 0 END + CASE WHEN c.category = 'TEXTBOOK' THEN 5 ELSE 0 END
           )::DOUBLE PRECISION AS score,
           CASE WHEN c.sem_match THEN 'Matches your department and semester'
                WHEN c.dept_match THEN 'Matches your department'
                WHEN c.wish_book OR c.wish_course OR c.wish_subject OR (c.has_sim AND c.sim > 0.5) THEN 'Similar to your favorites'
                WHEN c.recent_book OR c.recent_course OR c.bought_subject THEN 'Related to your activity'
                WHEN c.same_campus AND c.category = 'TEXTBOOK' THEN 'Available on your campus'
                ELSE 'Recently listed' END AS reason
    FROM cand c
    ORDER BY score DESC, c.created_at DESC, c.listing_id DESC
    LIMIT p_limit;
$$;

