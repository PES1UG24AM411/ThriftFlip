-- 017_wanted_books_and_cycle_swaps.sql
-- 1. Wanted books: the book a seller wants in return was stored in two places (swap_preference, used for
--    matching, and listing_wanted_book, added in 016, used for display), so a preference saved on the Swaps page
--    (e.g. listing 11 wanting "Advanced Engineering Mathematics") never showed on the listing page or the card.
--    Now: books chosen on the listing form are copied into swap_preference (so matching sees them), and the display
--    shows both sources without duplicates. Nothing is deleted.
-- 2. Circular swaps (3 or more students) can now be completed: every participant accepts, then every participant
--    confirms the exchange. Only when ALL have confirmed are the listings SWAPPED and the deals recorded.
--    Conflicting swaps are blocked in both directions (a book can be in one open swap at a time).

-- ---------------------------------------------------------------------------
-- 1. Wanted books
-- ---------------------------------------------------------------------------
INSERT INTO swap_preference (student_id, offered_listing_id, wanted_book_id)
SELECT l.seller_id, l.listing_id, w.book_id
FROM listing_wanted_book w JOIN listing l ON l.listing_id = w.listing_id
WHERE w.book_id IS NOT NULL
ON CONFLICT (offered_listing_id, wanted_book_id) DO NOTHING;

CREATE OR REPLACE VIEW v_listing_details AS
SELECT
    l.listing_id, l.title, l.description, l.category, l.item_condition, l.listing_type,
    l.price, l.status, l.open_to_swap, l.created_at,
    l.seller_id, s.name AS seller_name,
    rt.avg_rating AS seller_avg_rating, rt.rating_count AS seller_rating_count,
    l.campus_id, c.name AS campus_name,
    b.book_id, b.isbn, b.author, b.edition, b.subject,
    co.course_id, co.code AS course_code, co.name AS course_name,
    a.auction_id, a.end_time AS auction_end_time,
    COALESCE(a.current_price, l.price) AS current_price,
    dep.department_id AS department_id, dep.name AS department_name, co.semester AS course_semester,
    (SELECT li.image_id FROM listing_image li WHERE li.listing_id = l.listing_id ORDER BY li.position, li.image_id LIMIT 1) AS cover_image_id,
    (SELECT COUNT(*) FROM wishlist w WHERE w.listing_id = l.listing_id) AS wishlist_count,
    b.cover_url AS cover_url,
    (SELECT string_agg(x.title, ' | ' ORDER BY x.ord)
       FROM (SELECT w.wanted_id AS ord, COALESCE(wb.title, w.custom_title) AS title
               FROM listing_wanted_book w LEFT JOIN book wb ON wb.book_id = w.book_id
              WHERE w.listing_id = l.listing_id
             UNION ALL
             SELECT 1000000 + sp.preference_id, pb.title
               FROM swap_preference sp JOIN book pb ON pb.book_id = sp.wanted_book_id
              WHERE sp.offered_listing_id = l.listing_id
                AND NOT EXISTS (SELECT 1 FROM listing_wanted_book w2
                                 WHERE w2.listing_id = l.listing_id AND w2.book_id = sp.wanted_book_id)) x) AS wanted_books
FROM listing l
JOIN student s ON s.student_id = l.seller_id
JOIN campus c ON c.campus_id = l.campus_id
JOIN v_student_ratings rt ON rt.student_id = l.seller_id
LEFT JOIN book b ON b.book_id = l.book_id
LEFT JOIN course co ON co.course_id = b.course_id
LEFT JOIN department dep ON dep.department_id = co.department_id
LEFT JOIN auction a ON a.listing_id = l.listing_id;

-- ---------------------------------------------------------------------------
-- 2. Circular swaps
-- ---------------------------------------------------------------------------
ALTER TABLE swap_request ADD COLUMN confirmed_at TIMESTAMPTZ; -- requester confirmed the books were exchanged
ALTER TABLE swap_request DROP CONSTRAINT ck_swap_status;
ALTER TABLE swap_request ADD CONSTRAINT ck_swap_status CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED'));

-- a book can be in only one open swap: a direct proposal cannot be made for a book that is in an open circle
CREATE FUNCTION swap_proposal_not_in_cycle() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM swap_request WHERE status IN ('PENDING', 'ACCEPTED')
                 AND (offered_listing_id IN (NEW.offered_listing_id, NEW.requested_listing_id)
                   OR requested_listing_id IN (NEW.offered_listing_id, NEW.requested_listing_id))) THEN
        RAISE EXCEPTION 'One of these books is already part of another swap in progress' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_swap_proposal_not_in_cycle BEFORE INSERT ON swap_proposal FOR EACH ROW EXECUTE FUNCTION swap_proposal_not_in_cycle();

-- matching: books already in an open circle are not suggested again
CREATE OR REPLACE FUNCTION find_swap_cycles(p_student_id INTEGER DEFAULT NULL, p_max_length INTEGER DEFAULT 4)
RETURNS TABLE (swap_type TEXT, cycle_length INTEGER, listing_ids INTEGER[], student_ids INTEGER[])
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE edges AS (
        SELECT DISTINCT
            la.listing_id AS from_id, la.seller_id AS from_student,
            lb.listing_id AS to_id,   lb.seller_id AS to_student
        FROM swap_preference sp
        JOIN listing la ON la.listing_id = sp.offered_listing_id
        JOIN listing lb ON lb.book_id = sp.wanted_book_id
        WHERE la.status = 'ACTIVE' AND la.open_to_swap AND la.listing_type = 'FIXED_PRICE'
          AND lb.status = 'ACTIVE' AND lb.open_to_swap AND lb.listing_type = 'FIXED_PRICE'
          AND la.seller_id <> lb.seller_id
          AND NOT EXISTS (SELECT 1 FROM swap_request r WHERE r.status IN ('PENDING', 'ACCEPTED')
                            AND la.listing_id IN (r.offered_listing_id, r.requested_listing_id))
          AND NOT EXISTS (SELECT 1 FROM swap_request r WHERE r.status IN ('PENDING', 'ACCEPTED')
                            AND lb.listing_id IN (r.offered_listing_id, r.requested_listing_id))
    ),
    walk (start_id, current_id, path, students, len) AS (
        SELECT e.from_id, e.to_id, ARRAY[e.from_id, e.to_id], ARRAY[e.from_student, e.to_student], 2
        FROM edges e
        WHERE e.to_id > e.from_id
        UNION ALL
        SELECT w.start_id, e.to_id, w.path || e.to_id, w.students || e.to_student, w.len + 1
        FROM walk w
        JOIN edges e ON e.from_id = w.current_id
        WHERE e.to_id > w.start_id
          AND NOT (e.to_id = ANY (w.path))
          AND NOT (e.to_student = ANY (w.students))
          AND w.len < p_max_length
    )
    SELECT CASE WHEN w.len = 2 THEN 'DIRECT' ELSE 'MULTI_WAY' END,
           w.len,
           w.path,
           w.students
    FROM walk w
    JOIN edges closing ON closing.from_id = w.current_id AND closing.to_id = w.start_id
    WHERE p_student_id IS NULL OR p_student_id = ANY (w.students)
    ORDER BY w.len, w.path;
$$;

-- closes an open circle: every request is CANCELLED and books reserved by the circle become available again
CREATE FUNCTION close_swap_cycle(p_cycle UUID, p_message TEXT, p_except_student INTEGER DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_reserved BOOLEAN;
BEGIN
    v_reserved := NOT EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = p_cycle AND status = 'PENDING')
                  AND EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = p_cycle AND status = 'ACCEPTED');
    UPDATE swap_request SET status = 'CANCELLED', responded_at = now()
    WHERE cycle_id = p_cycle AND status IN ('PENDING', 'ACCEPTED');
    IF v_reserved THEN
        PERFORM set_config('app.swap_cycle_flag', 'on', true);
        UPDATE listing SET status = 'ACTIVE'
        WHERE status = 'RESERVED' AND listing_id IN (SELECT requested_listing_id FROM swap_request WHERE cycle_id = p_cycle);
        PERFORM set_config('app.swap_cycle_flag', 'off', true);
    END IF;
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT r.requester_id, 'SWAP_UPDATE', 'Swap called off', p_message, r.offered_listing_id
    FROM swap_request r WHERE r.cycle_id = p_cycle AND r.requester_id IS DISTINCT FROM p_except_student;
END;
$$;

-- a book of an open circle disappears (sold, removed, no longer open to swaps): the circle is closed
CREATE FUNCTION listing_cancels_swap_cycles() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_cycle UUID;
BEGIN
    IF current_setting('app.swap_cycle_flag', true) = 'on' THEN
        RETURN NULL;
    END IF;
    IF NOT ((OLD.status = 'ACTIVE' AND NEW.status NOT IN ('ACTIVE', 'RESERVED'))
         OR (OLD.status = 'ACTIVE' AND NEW.status = 'RESERVED')
         OR (OLD.status = 'RESERVED' AND NEW.status = 'REMOVED')
         OR (OLD.open_to_swap AND NOT NEW.open_to_swap AND NEW.status = 'ACTIVE')) THEN
        RETURN NULL;
    END IF;
    FOR v_cycle IN
        SELECT DISTINCT cycle_id FROM swap_request
        WHERE status IN ('PENDING', 'ACCEPTED') AND NEW.listing_id IN (offered_listing_id, requested_listing_id)
    LOOP
        PERFORM close_swap_cycle(v_cycle, 'A book in your swap is no longer available, so the swap was called off.');
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER trg_listing_cancels_swap_cycles
AFTER UPDATE OF status, open_to_swap ON listing
FOR EACH ROW EXECUTE FUNCTION listing_cancels_swap_cycles();

-- propose_swap_cycle: as before, plus the checks that keep swaps from conflicting
CREATE OR REPLACE FUNCTION propose_swap_cycle(p_path INTEGER[], p_initiator_id INTEGER)
RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
    v_cycle UUID := gen_random_uuid();
    v_n INTEGER := COALESCE(array_length(p_path, 1), 0);
    i INTEGER;
BEGIN
    IF v_n < 2 OR v_n > 6 THEN
        RAISE EXCEPTION 'A swap needs between 2 and 6 listings' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT COUNT(DISTINCT x) FROM unnest(p_path) AS x) <> v_n THEN
        RAISE EXCEPTION 'A listing appears twice in the swap' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT status FROM student WHERE student_id = p_initiator_id) IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'Only active students can propose swaps' USING ERRCODE = 'check_violation';
    END IF;

    PERFORM 1 FROM listing WHERE listing_id = ANY (p_path) ORDER BY listing_id FOR UPDATE;

    IF (SELECT COUNT(*) FROM listing
        WHERE listing_id = ANY (p_path) AND status = 'ACTIVE' AND open_to_swap AND listing_type = 'FIXED_PRICE') <> v_n THEN
        RAISE EXCEPTION 'Every listing must be active and open to swaps' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT COUNT(DISTINCT seller_id) FROM listing WHERE listing_id = ANY (p_path)) <> v_n THEN
        RAISE EXCEPTION 'Each listing must belong to a different student' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM listing WHERE listing_id = ANY (p_path) AND seller_id = p_initiator_id) THEN
        RAISE EXCEPTION 'You must own one of the listings in the swap' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM swap_request
               WHERE status IN ('PENDING', 'ACCEPTED')
                 AND (offered_listing_id = ANY (p_path) OR requested_listing_id = ANY (p_path))) THEN
        RAISE EXCEPTION 'One of the listings is already part of another swap request' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM swap_proposal
               WHERE status IN ('PENDING', 'ACCEPTED')
                 AND (offered_listing_id = ANY (p_path) OR requested_listing_id = ANY (p_path))) THEN
        RAISE EXCEPTION 'One of the listings is already part of a swap proposal in progress' USING ERRCODE = 'check_violation';
    END IF;

    FOR i IN 1..v_n LOOP
        INSERT INTO swap_request (cycle_id, requester_id, offered_listing_id, requested_listing_id)
        SELECT v_cycle, a.seller_id, a.listing_id, b.listing_id
        FROM listing a, listing b
        WHERE a.listing_id = p_path[i] AND b.listing_id = p_path[(i % v_n) + 1];
    END LOOP;

    -- the initiator agrees to give away their own listing
    UPDATE swap_request SET status = 'ACCEPTED', responded_at = now()
    WHERE cycle_id = v_cycle
      AND requested_listing_id IN (SELECT listing_id FROM listing WHERE seller_id = p_initiator_id AND listing_id = ANY (p_path));

    -- everybody else is asked
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT l.seller_id, 'SWAP_MATCH', 'Swap proposal',
           'A ' || CASE WHEN v_n = 2 THEN 'direct' ELSE v_n || '-way' END || ' swap involves your listing "' || l.title || '". Open Swaps to accept or reject.',
           l.listing_id
    FROM listing l
    WHERE l.listing_id = ANY (p_path) AND l.seller_id <> p_initiator_id;

    RETURN v_cycle;
END;
$$;

-- respond_swap_request: the owner of the REQUESTED listing accepts or rejects (they give that item away).
-- Rejecting closes the whole circle. When EVERY request is accepted the books are reserved and everybody is told to
-- exchange them; the swap is completed later, by confirm_swap_cycle, when every participant has confirmed.
-- Returns 'REJECTED', 'WAITING' (others must still answer) or 'READY' (everyone accepted).
CREATE OR REPLACE FUNCTION respond_swap_request(p_request_id INTEGER, p_student_id INTEGER, p_accept BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_req swap_request%ROWTYPE;
    v_owner INTEGER;
BEGIN
    SELECT * INTO v_req FROM swap_request WHERE swap_request_id = p_request_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Swap request not found' USING ERRCODE = 'no_data_found';
    END IF;
    PERFORM 1 FROM listing WHERE listing_id IN (SELECT requested_listing_id FROM swap_request WHERE cycle_id = v_req.cycle_id) ORDER BY listing_id FOR UPDATE;
    PERFORM 1 FROM swap_request WHERE cycle_id = v_req.cycle_id ORDER BY swap_request_id FOR UPDATE;
    SELECT * INTO v_req FROM swap_request WHERE swap_request_id = p_request_id;

    SELECT seller_id INTO v_owner FROM listing WHERE listing_id = v_req.requested_listing_id;
    IF v_owner <> p_student_id THEN
        RAISE EXCEPTION 'Only the owner of the requested listing can answer' USING ERRCODE = 'check_violation';
    END IF;
    IF v_req.status <> 'PENDING' THEN
        RAISE EXCEPTION 'This request was already answered' USING ERRCODE = 'check_violation';
    END IF;

    IF NOT p_accept THEN
        UPDATE swap_request SET status = 'REJECTED', responded_at = now() WHERE swap_request_id = p_request_id;
        PERFORM close_swap_cycle(v_req.cycle_id, 'One student rejected the swap, so it was called off.', p_student_id);
        RETURN 'REJECTED';
    END IF;

    UPDATE swap_request SET status = 'ACCEPTED', responded_at = now() WHERE swap_request_id = p_request_id;

    IF EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = v_req.cycle_id AND status <> 'ACCEPTED') THEN
        RETURN 'WAITING';
    END IF;

    -- everybody agreed: reserve the books (the flag keeps the cancel trigger quiet) and tell everyone
    PERFORM set_config('app.swap_cycle_flag', 'on', true);
    UPDATE listing SET status = 'RESERVED'
    WHERE listing_id IN (SELECT requested_listing_id FROM swap_request WHERE cycle_id = v_req.cycle_id);
    UPDATE offer SET status = 'REJECTED', responded_at = now()
    WHERE status = 'PENDING' AND listing_id IN (SELECT requested_listing_id FROM swap_request WHERE cycle_id = v_req.cycle_id);
    PERFORM set_config('app.swap_cycle_flag', 'off', true);
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT r.requester_id, 'SWAP_UPDATE', 'Swap agreed by everyone',
           'Everyone accepted. Meet up, exchange the books, then confirm in THRIFTFLIP. The swap completes when all of you have confirmed.', r.requested_listing_id
    FROM swap_request r WHERE r.cycle_id = v_req.cycle_id;
    RETURN 'READY';
END;
$$;

-- confirm_swap_cycle: after the exchange EACH participant confirms once. Only when all have confirmed the swap is
-- COMPLETED: the books become SWAPPED and one finished deal per participant is written (for history and ratings).
-- Returns 'WAITING' or 'COMPLETED'.
CREATE FUNCTION confirm_swap_cycle(p_cycle UUID, p_student_id INTEGER)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_mine swap_request%ROWTYPE;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = p_cycle AND requester_id = p_student_id) THEN
        RAISE EXCEPTION 'Swap not found' USING ERRCODE = 'no_data_found';
    END IF;
    PERFORM 1 FROM listing WHERE listing_id IN (SELECT requested_listing_id FROM swap_request WHERE cycle_id = p_cycle) ORDER BY listing_id FOR UPDATE;
    PERFORM 1 FROM swap_request WHERE cycle_id = p_cycle ORDER BY swap_request_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = p_cycle AND status <> 'ACCEPTED') THEN
        RAISE EXCEPTION 'Only a swap that everybody accepted can be confirmed' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM transactions t JOIN swap_request r ON r.swap_request_id = t.swap_request_id WHERE r.cycle_id = p_cycle) THEN
        RAISE EXCEPTION 'This older swap is followed on the Deals page' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_mine FROM swap_request WHERE cycle_id = p_cycle AND requester_id = p_student_id;
    IF v_mine.confirmed_at IS NOT NULL THEN
        RETURN 'WAITING';
    END IF;
    UPDATE swap_request SET confirmed_at = now() WHERE swap_request_id = v_mine.swap_request_id;

    IF EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = p_cycle AND confirmed_at IS NULL) THEN
        INSERT INTO notification (student_id, type, title, body, related_listing_id)
        SELECT r.requester_id, 'SWAP_UPDATE', 'Swap: please confirm',
               'Another student confirmed the exchange. Confirm in THRIFTFLIP if you also exchanged your book.', r.requested_listing_id
        FROM swap_request r WHERE r.cycle_id = p_cycle AND r.confirmed_at IS NULL;
        RETURN 'WAITING';
    END IF;

    UPDATE swap_request SET status = 'COMPLETED' WHERE cycle_id = p_cycle;
    PERFORM set_config('app.swap_cycle_flag', 'on', true);
    UPDATE listing SET status = 'SWAPPED', open_to_swap = false
    WHERE listing_id IN (SELECT offered_listing_id FROM swap_request WHERE cycle_id = p_cycle);
    PERFORM set_config('app.swap_cycle_flag', 'off', true);
    INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, transaction_type, swap_request_id, state)
    SELECT r.requested_listing_id, r.requester_id, l.seller_id, 0, 'SWAP', r.swap_request_id, 'RELEASED'
    FROM swap_request r JOIN listing l ON l.listing_id = r.requested_listing_id
    WHERE r.cycle_id = p_cycle;
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT r.requester_id, 'SWAP_UPDATE', 'Swap completed',
           'Your swap is complete. You can now rate the student who gave you a book.', r.requested_listing_id
    FROM swap_request r WHERE r.cycle_id = p_cycle;
    RETURN 'COMPLETED';
END;
$$;

-- cancel_swap_cycle: any participant can call off a circle that is not completed yet
CREATE FUNCTION cancel_swap_cycle(p_cycle UUID, p_student_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = p_cycle AND requester_id = p_student_id) THEN
        RAISE EXCEPTION 'Swap not found' USING ERRCODE = 'no_data_found';
    END IF;
    PERFORM 1 FROM listing WHERE listing_id IN (SELECT requested_listing_id FROM swap_request WHERE cycle_id = p_cycle) ORDER BY listing_id FOR UPDATE;
    PERFORM 1 FROM swap_request WHERE cycle_id = p_cycle ORDER BY swap_request_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = p_cycle AND status IN ('PENDING', 'ACCEPTED')) THEN
        RAISE EXCEPTION 'This swap is already finished' USING ERRCODE = 'check_violation';
    END IF;
    PERFORM close_swap_cycle(p_cycle, 'A student called off the swap.', p_student_id);
END;
$$;
