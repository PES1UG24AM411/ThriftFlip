-- 018_simplify_and_fixes.sql
-- A new, additive migration (older files are NOT edited and no user data is deleted).
--
--   1. Wanted books      new table student_wanted_book: any book a student wants (also books nobody sells yet).
--   2. Swap matching     find_swap_cycles also uses the wanted books, skips books already in a swap proposal and is
--                        used with a maximum of 3 students. notify_swap_matches() tells each student once about
--                        a new match; notify_wanted_book_available() tells a student once when a wanted book
--                        becomes open for swapping. Nothing is ever swapped automatically.
--   3. Price alerts      an alert keeps watching after it fires and tells the student once per listing.
--   4. Auctions          the winner is the highest VALID bid; both people are notified with the final price and the
--                        winner's details; an auction without bids tells the seller; the listing is no longer
--                        "reserved" after an auction.
--   5. Waitlist removed  the waitlist functions and the view are dropped (the old waitlist table and its rows are kept).
--   6. Messages          a message notification now knows its conversation, so a click opens the right chat.
--   7. Admin             a warning sent from a report is saved as a WARNING message and counted.

-- ---------------------------------------------------------------------------
-- 1. Wanted books (one row per student and book)
-- ---------------------------------------------------------------------------
CREATE TABLE student_wanted_book (
    wanted_book_id SERIAL PRIMARY KEY, -- surrogate key
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- student who wants the book
    book_id INTEGER NOT NULL REFERENCES book(book_id), -- the wanted book (a catalogue book; typed books are added to the catalogue)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (student_id, book_id)
);
CREATE INDEX idx_student_wanted_book_book ON student_wanted_book (book_id);

-- ---------------------------------------------------------------------------
-- Notifications: two new types and the conversation a message belongs to
-- ---------------------------------------------------------------------------
ALTER TABLE notification DROP CONSTRAINT ck_notification_type;
ALTER TABLE notification ADD CONSTRAINT ck_notification_type CHECK (type IN (
    'OUTBID', 'AUCTION_WON', 'AUCTION_SOLD', 'AUCTION_ENDING', 'NEW_OFFER', 'OFFER_ACCEPTED', 'SWAP_MATCH',
    'WAITLIST_AVAILABLE', 'PRICE_ALERT', 'PURCHASE', 'TRANSACTION_UPDATE', 'MESSAGE', 'REPORT_UPDATE', 'LISTING_SOLD',
    'SWAP_PROPOSAL', 'SWAP_UPDATE', 'ADMIN_MESSAGE', 'WANTED_BOOK', 'AUCTION_NO_BIDS'));
-- ('WAITLIST_AVAILABLE' stays in the list only because old notifications with that type may exist.)

ALTER TABLE notification ADD COLUMN related_conversation_id INTEGER REFERENCES conversation(conversation_id) ON DELETE SET NULL;

-- old message notifications: link them to the chat of that listing the student takes part in (most recent message first)
UPDATE notification n
SET related_conversation_id = (
    SELECT c.conversation_id FROM conversation c
    WHERE c.listing_id = n.related_listing_id AND n.student_id IN (c.buyer_id, c.seller_id)
    ORDER BY (SELECT MAX(m.sent_at) FROM message m WHERE m.conversation_id = c.conversation_id) DESC NULLS LAST
    LIMIT 1)
WHERE n.type = 'MESSAGE' AND n.related_conversation_id IS NULL AND n.related_listing_id IS NOT NULL;

-- A student is told about a wanted book at most once per listing (the database refuses a second notification).
CREATE UNIQUE INDEX uq_notification_wanted_book ON notification (student_id, related_listing_id) WHERE type = 'WANTED_BOOK';

-- ---------------------------------------------------------------------------
-- 6. Messages: the notification points to the conversation. While the other student has not read the
--    last notification of this chat yet, no second one is created.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION message_after_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_conv conversation%ROWTYPE;
    v_recipient INTEGER;
BEGIN
    SELECT * INTO v_conv FROM conversation WHERE conversation_id = NEW.conversation_id;
    IF NEW.sender_id NOT IN (v_conv.buyer_id, v_conv.seller_id) THEN
        RAISE EXCEPTION 'Sender is not part of this conversation' USING ERRCODE = 'check_violation';
    END IF;
    v_recipient := CASE WHEN NEW.sender_id = v_conv.buyer_id THEN v_conv.seller_id ELSE v_conv.buyer_id END;
    IF NOT EXISTS (SELECT 1 FROM notification
                   WHERE student_id = v_recipient AND type = 'MESSAGE' AND NOT is_read
                     AND related_conversation_id = v_conv.conversation_id) THEN
        INSERT INTO notification (student_id, type, title, body, related_listing_id, related_conversation_id)
        VALUES (v_recipient, 'MESSAGE', 'New message',
                (SELECT name FROM student WHERE student_id = NEW.sender_id) || ' sent you a message.',
                v_conv.listing_id, v_conv.conversation_id);
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Price alerts: only fixed-price listings count; the alert keeps watching; one notification per listing
-- ---------------------------------------------------------------------------
UPDATE price_alert SET is_active = true WHERE NOT is_active; -- old alerts stopped after the first hit: let them watch again

CREATE OR REPLACE FUNCTION listing_price_alerts() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_relevant BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_relevant := true;
    ELSE
        v_relevant := OLD.price IS DISTINCT FROM NEW.price OR OLD.status IS DISTINCT FROM NEW.status;
    END IF;
    IF v_relevant AND NEW.status = 'ACTIVE' AND NEW.listing_type = 'FIXED_PRICE' AND NEW.book_id IS NOT NULL THEN
        WITH hit AS (
            UPDATE price_alert SET triggered_at = now()
            WHERE is_active AND book_id = NEW.book_id AND max_price >= NEW.price AND student_id <> NEW.seller_id
            RETURNING student_id
        )
        INSERT INTO notification (student_id, type, title, body, related_listing_id)
        SELECT DISTINCT hit.student_id, 'PRICE_ALERT', 'Price alert',
               '"' || NEW.title || '" is listed for ₹' || NEW.price || ', within your price limit.', NEW.listing_id
        FROM hit
        WHERE NOT EXISTS (SELECT 1 FROM notification n
                          WHERE n.student_id = hit.student_id AND n.type = 'PRICE_ALERT' AND n.related_listing_id = NEW.listing_id);
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Swap matching
-- ---------------------------------------------------------------------------
-- Which swap matches have we already told a student about? (key = the listing ids of the match)
CREATE TABLE swap_match_notice (
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE,
    cycle_key TEXT NOT NULL, -- for example '12-31-44'
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (student_id, cycle_key)
);

-- find_swap_cycles: a graph walk with a recursive query.
--   node = an ACTIVE, swap-enabled, fixed-price listing that is not already in an open swap
--   edge = listing A -> listing B when the owner of A wants the book of B. "Wants" comes from two places:
--          the "What I want in return" preferences of one listing (swap_preference) and the student's
--          wanted-book list (student_wanted_book, valid for all of the student's swap-enabled listings).
-- A cycle A -> B -> C -> A is a three-way swap (A gives X to C, B gives Y to A, C gives Z to B).
-- Every student appears once per cycle and each cycle is reported once (it starts at its smallest listing id).
-- The app asks for p_max_length = 3: direct swaps (2 students) and three-way swaps.
CREATE OR REPLACE FUNCTION find_swap_cycles(p_student_id INTEGER DEFAULT NULL, p_max_length INTEGER DEFAULT 4)
RETURNS TABLE (swap_type TEXT, cycle_length INTEGER, listing_ids INTEGER[], student_ids INTEGER[])
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE wants AS (
        SELECT offered_listing_id AS listing_id, wanted_book_id AS book_id FROM swap_preference
        UNION
        SELECT l.listing_id, w.book_id
        FROM student_wanted_book w JOIN listing l ON l.seller_id = w.student_id
    ),
    open_listing AS (
        SELECT l.listing_id, l.book_id, l.seller_id
        FROM listing l
        WHERE l.status = 'ACTIVE' AND l.open_to_swap AND l.listing_type = 'FIXED_PRICE'
          AND NOT EXISTS (SELECT 1 FROM swap_request r WHERE r.status IN ('PENDING', 'ACCEPTED')
                            AND l.listing_id IN (r.offered_listing_id, r.requested_listing_id))
          AND NOT EXISTS (SELECT 1 FROM swap_proposal p WHERE p.status IN ('PENDING', 'ACCEPTED')
                            AND l.listing_id IN (p.offered_listing_id, p.requested_listing_id))
    ),
    edges AS (
        SELECT DISTINCT
            la.listing_id AS from_id, la.seller_id AS from_student,
            lb.listing_id AS to_id,   lb.seller_id AS to_student
        FROM wants
        JOIN open_listing la ON la.listing_id = wants.listing_id
        JOIN open_listing lb ON lb.book_id = wants.book_id
        WHERE la.seller_id <> lb.seller_id
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

-- notify_swap_matches: every student who is part of a current match and has not been told about it yet gets ONE
-- notification. Returns how many notifications were created. It only informs: no swap is proposed or completed.
CREATE FUNCTION notify_swap_matches() RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_count INTEGER;
BEGIN
    WITH matches AS (
        SELECT array_to_string(c.listing_ids, '-') AS cycle_key,
               c.cycle_length,
               u.student_id,
               c.listing_ids[u.pos::INTEGER] AS own_listing_id
        FROM find_swap_cycles(NULL, 3) c
        CROSS JOIN LATERAL unnest(c.student_ids) WITH ORDINALITY AS u(student_id, pos)
    ),
    fresh AS (
        INSERT INTO swap_match_notice (student_id, cycle_key)
        SELECT student_id, cycle_key FROM matches
        ON CONFLICT DO NOTHING
        RETURNING student_id, cycle_key
    ),
    sent AS (
        INSERT INTO notification (student_id, type, title, body, related_listing_id)
        SELECT m.student_id, 'SWAP_MATCH',
               CASE WHEN m.cycle_length = 2 THEN 'Swap match found' ELSE 'Three-way swap match found' END,
               'Your book "' || l.title || '" can be swapped with ' || (m.cycle_length - 1) || ' other student'
                   || CASE WHEN m.cycle_length = 2 THEN '' ELSE 's' END
                   || '. Open Swaps to see the match, message the others or propose the swap. Nothing happens until everybody agrees.',
               m.own_listing_id
        FROM fresh f
        JOIN matches m ON m.student_id = f.student_id AND m.cycle_key = f.cycle_key
        JOIN listing l ON l.listing_id = m.own_listing_id
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_count FROM sent;
    RETURN v_count;
END;
$$;

-- notify_wanted_book_available: when a listing is open for swapping, every other student who has its book on the
-- wanted list is told once (the unique index uq_notification_wanted_book also guards against duplicates).
CREATE FUNCTION notify_wanted_book_available(p_listing_id INTEGER) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_count INTEGER;
BEGIN
    WITH sent AS (
        INSERT INTO notification (student_id, type, title, body, related_listing_id)
        SELECT w.student_id, 'WANTED_BOOK', 'A book you want is open for swapping',
               '"' || l.title || '" is now open for swapping. Open the listing to propose a swap.', l.listing_id
        FROM listing l
        JOIN student_wanted_book w ON w.book_id = l.book_id
        JOIN student s ON s.student_id = w.student_id AND s.status = 'ACTIVE'
        WHERE l.listing_id = p_listing_id
          AND l.status = 'ACTIVE' AND l.open_to_swap AND l.listing_type = 'FIXED_PRICE'
          AND w.student_id <> l.seller_id
        ON CONFLICT (student_id, related_listing_id) WHERE type = 'WANTED_BOOK' DO NOTHING
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_count FROM sent;
    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Auctions: the highest valid bid wins; no reservation and no waitlist afterwards
-- ---------------------------------------------------------------------------
-- close_auction: after end_time the auction is CLOSED.
--   winner = the highest VALID bid placed by an ACTIVE student (the earlier bid wins a tie)
--   no valid bid -> the listing is withdrawn and the seller is told
--   winner       -> an AUCTION_WIN transaction (same payment steps as before) and a notification for both people
-- Returns the transaction id, or NULL when nobody bid.
CREATE OR REPLACE FUNCTION close_auction(p_auction_id INTEGER, p_now TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_auction auction%ROWTYPE;
    v_listing listing%ROWTYPE;
    v_winner INTEGER;
    v_price NUMERIC;
    v_winner_info TEXT;
    v_seller_name TEXT;
    v_tx_id INTEGER;
BEGIN
    SELECT * INTO v_auction FROM auction WHERE auction_id = p_auction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Auction % not found', p_auction_id USING ERRCODE = 'no_data_found';
    END IF;
    IF v_auction.status <> 'ACTIVE' THEN
        RETURN NULL;                                   -- already closed: nothing to do
    END IF;
    IF v_auction.end_time > p_now THEN
        RAISE EXCEPTION 'Auction has not ended yet' USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_listing FROM listing WHERE listing_id = v_auction.listing_id FOR UPDATE;

    SELECT b.bidder_id, b.amount INTO v_winner, v_price
    FROM bid b JOIN student s ON s.student_id = b.bidder_id
    WHERE b.auction_id = p_auction_id AND b.status = 'VALID' AND s.status = 'ACTIVE'
    ORDER BY b.amount DESC, b.placed_at, b.bid_id
    LIMIT 1;

    IF v_winner IS NULL THEN
        UPDATE auction SET status = 'CLOSED', highest_bidder_id = NULL, closed_at = p_now WHERE auction_id = p_auction_id;
        UPDATE listing SET status = 'REMOVED' WHERE listing_id = v_listing.listing_id;   -- unsold: withdrawn
        PERFORM tf_notify(v_listing.seller_id, 'AUCTION_NO_BIDS', 'Your auction ended without bids',
                          '"' || v_listing.title || '" received no valid bids, so the auction was closed and the listing removed. You can list it again.',
                          v_listing.listing_id);
        RETURN NULL;
    END IF;

    UPDATE auction
    SET status = 'CLOSED', winner_id = v_winner, highest_bidder_id = v_winner, current_price = v_price, closed_at = p_now
    WHERE auction_id = p_auction_id;

    INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, transaction_type)
    VALUES (v_listing.listing_id, v_winner, v_listing.seller_id, v_price, 'AUCTION_WIN')
    RETURNING transaction_id INTO v_tx_id;

    UPDATE listing SET status = 'SOLD' WHERE listing_id = v_listing.listing_id;   -- sold to the winner: not reserved, no waitlist

    -- what the seller may know about the winner: name and course, and the contact detail only if the winner allowed it
    SELECT s.name || ' (' || d.name || ', semester ' || s.semester || ')'
           || CASE WHEN s.show_contact AND s.contact_preference = 'PHONE' AND s.phone IS NOT NULL THEN '. Phone: ' || s.phone
                   WHEN s.show_contact AND s.contact_preference = 'EMAIL' THEN '. E-mail: ' || s.email
                   ELSE '. Contact them through THRIFTFLIP Messages' END
    INTO v_winner_info
    FROM student s JOIN department d ON d.department_id = s.department_id
    WHERE s.student_id = v_winner;
    SELECT name INTO v_seller_name FROM student WHERE student_id = v_listing.seller_id;

    PERFORM tf_notify(v_winner, 'AUCTION_WON', 'You won the auction',
                      'You won "' || v_listing.title || '" for ₹' || v_price || '. Seller: ' || v_seller_name
                      || '. Open Deals to follow the payment steps.', v_listing.listing_id);
    PERFORM tf_notify(v_listing.seller_id, 'AUCTION_SOLD', 'Your auction ended',
                      '"' || v_listing.title || '" sold for ₹' || v_price || '. Winner: ' || v_winner_info
                      || '. Open Deals to follow the payment steps.', v_listing.listing_id);
    RETURN v_tx_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Waitlist removed. Three functions only lose their waitlist lines (everything else in them is unchanged).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION create_purchase(p_listing_id INTEGER, p_buyer_id INTEGER, p_now TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_listing listing%ROWTYPE;
    v_buyer_status TEXT;
    v_tx_id INTEGER;
BEGIN
    SELECT * INTO v_listing FROM listing WHERE listing_id = p_listing_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Listing not found' USING ERRCODE = 'no_data_found';
    END IF;
    SELECT status INTO v_buyer_status FROM student WHERE student_id = p_buyer_id;
    IF v_buyer_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'Only active students can buy' USING ERRCODE = 'check_violation';
    END IF;
    IF v_listing.listing_type <> 'FIXED_PRICE' THEN
        RAISE EXCEPTION 'Auction items must be won through bidding' USING ERRCODE = 'check_violation';
    END IF;
    IF v_listing.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Listing is not available' USING ERRCODE = 'check_violation';
    END IF;
    IF v_listing.seller_id = p_buyer_id THEN
        RAISE EXCEPTION 'You cannot buy your own listing' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, transaction_type)
    VALUES (p_listing_id, p_buyer_id, v_listing.seller_id, v_listing.price, 'PURCHASE')
    RETURNING transaction_id INTO v_tx_id;

    UPDATE listing SET status = 'RESERVED' WHERE listing_id = p_listing_id;

    PERFORM tf_notify(v_listing.seller_id, 'PURCHASE', 'New purchase',
                      'Someone is buying "' || v_listing.title || '".', p_listing_id);
    RETURN v_tx_id;
END;
$$;

CREATE OR REPLACE FUNCTION tx_after_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_actor_type TEXT := COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'SYSTEM');
    v_actor_id INTEGER := NULLIF(current_setting('app.actor_id', true), '')::INTEGER;
    v_listing listing%ROWTYPE;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.state = OLD.state THEN
            RETURN NULL;
        END IF;
    END IF;

    INSERT INTO transaction_state_history (transaction_id, previous_state, new_state, changed_by_type, changed_by_id)
    VALUES (NEW.transaction_id,
            CASE WHEN TG_OP = 'UPDATE' THEN OLD.state ELSE NULL END,
            NEW.state, v_actor_type, v_actor_id);

    IF TG_OP = 'INSERT' THEN
        RETURN NULL;
    END IF;

    SELECT * INTO v_listing FROM listing WHERE listing_id = NEW.listing_id FOR UPDATE;

    IF NEW.state = 'RELEASED' THEN
        UPDATE listing SET status = CASE WHEN NEW.transaction_type = 'SWAP' THEN 'SWAPPED' ELSE 'SOLD' END
        WHERE listing_id = NEW.listing_id;
    ELSIF NEW.state = 'CANCELLED' THEN
        IF NEW.transaction_type = 'AUCTION_WIN' THEN
            UPDATE listing SET status = 'REMOVED' WHERE listing_id = NEW.listing_id;
        ELSE
            UPDATE listing SET status = 'ACTIVE' WHERE listing_id = NEW.listing_id;
        END IF;
    END IF;

    PERFORM tf_notify(NEW.buyer_id, 'TRANSACTION_UPDATE', 'Transaction updated',
                      '"' || v_listing.title || '" is now ' || NEW.state || '.', NEW.listing_id);
    PERFORM tf_notify(NEW.seller_id, 'TRANSACTION_UPDATE', 'Transaction updated',
                      '"' || v_listing.title || '" is now ' || NEW.state || '.', NEW.listing_id);
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION respond_swap_proposal(p_proposal_id INTEGER, p_student_id INTEGER, p_action TEXT)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_p swap_proposal%ROWTYPE;
    v_off listing%ROWTYPE;
    v_req listing%ROWTYPE;
BEGIN
    IF p_action NOT IN ('accept', 'reject', 'cancel') THEN
        RAISE EXCEPTION 'Unknown action' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_p FROM swap_proposal WHERE swap_proposal_id = p_proposal_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Swap proposal not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF p_student_id NOT IN (v_p.proposer_id, v_p.receiver_id) THEN
        -- do not reveal that the proposal exists
        RAISE EXCEPTION 'Swap proposal not found' USING ERRCODE = 'no_data_found';
    END IF;
    PERFORM 1 FROM listing WHERE listing_id IN (v_p.offered_listing_id, v_p.requested_listing_id) ORDER BY listing_id FOR UPDATE;
    SELECT * INTO v_p FROM swap_proposal WHERE swap_proposal_id = p_proposal_id FOR UPDATE; -- re-read under the lock
    SELECT * INTO v_off FROM listing WHERE listing_id = v_p.offered_listing_id;
    SELECT * INTO v_req FROM listing WHERE listing_id = v_p.requested_listing_id;

    IF p_action = 'accept' THEN
        IF p_student_id <> v_p.receiver_id THEN
            RAISE EXCEPTION 'Only the owner of the requested book can accept' USING ERRCODE = 'check_violation';
        END IF;
        IF v_p.status <> 'PENDING' THEN
            RAISE EXCEPTION 'This proposal is already % and cannot be accepted', lower(v_p.status) USING ERRCODE = 'check_violation';
        END IF;
        IF v_off.status <> 'ACTIVE' OR v_req.status <> 'ACTIVE' THEN
            RAISE EXCEPTION 'One of the books is no longer available' USING ERRCODE = 'check_violation';
        END IF;
        UPDATE swap_proposal SET status = 'ACCEPTED', responded_at = now(), updated_at = now() WHERE swap_proposal_id = p_proposal_id;
        UPDATE listing SET status = 'RESERVED' WHERE listing_id IN (v_p.offered_listing_id, v_p.requested_listing_id);
        -- (trigger trg_listing_cancels_swap_proposals closes the other open proposals that need one of these books)
        -- reserved books are not for sale any more: offers waiting on them are closed
        UPDATE offer SET status = 'REJECTED', responded_at = now()
        WHERE status = 'PENDING' AND listing_id IN (v_p.offered_listing_id, v_p.requested_listing_id);
        PERFORM tf_notify(v_p.proposer_id, 'SWAP_UPDATE', 'Swap accepted',
            'Your swap for "' || v_req.title || '" was accepted. Meet up, exchange the books, then confirm in THRIFTFLIP.', v_p.requested_listing_id);
        RETURN 'ACCEPTED';
    END IF;

    IF p_action = 'reject' THEN
        IF p_student_id <> v_p.receiver_id THEN
            RAISE EXCEPTION 'Only the owner of the requested book can reject' USING ERRCODE = 'check_violation';
        END IF;
        IF v_p.status <> 'PENDING' THEN
            RAISE EXCEPTION 'This proposal is already % and cannot be rejected', lower(v_p.status) USING ERRCODE = 'check_violation';
        END IF;
        UPDATE swap_proposal SET status = 'REJECTED', responded_at = now(), updated_at = now() WHERE swap_proposal_id = p_proposal_id;
        PERFORM tf_notify(v_p.proposer_id, 'SWAP_UPDATE', 'Swap rejected',
            'Your swap proposal for "' || v_req.title || '" was rejected.', v_p.requested_listing_id);
        RETURN 'REJECTED';
    END IF;

    -- cancel
    IF v_p.status = 'PENDING' THEN
        IF p_student_id <> v_p.proposer_id THEN
            RAISE EXCEPTION 'Only the student who proposed the swap can cancel it (you can reject it instead)' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF v_p.status = 'ACCEPTED' THEN
        NULL; -- either student may call off an accepted swap that was not completed yet
    ELSE
        RAISE EXCEPTION 'This proposal is already % and cannot be cancelled', lower(v_p.status) USING ERRCODE = 'check_violation';
    END IF;
    IF v_p.status = 'ACCEPTED' THEN
        UPDATE listing SET status = 'ACTIVE' WHERE listing_id IN (v_p.offered_listing_id, v_p.requested_listing_id) AND status = 'RESERVED';
    END IF;
    UPDATE swap_proposal SET status = 'CANCELLED', responded_at = now(), updated_at = now() WHERE swap_proposal_id = p_proposal_id;
    PERFORM tf_notify(CASE WHEN p_student_id = v_p.proposer_id THEN v_p.receiver_id ELSE v_p.proposer_id END,
        'SWAP_UPDATE', 'Swap cancelled',
        'The swap "' || v_off.title || '" for "' || v_req.title || '" was cancelled.', v_p.requested_listing_id);
    RETURN 'CANCELLED';
END;
$$;

DROP FUNCTION expire_waitlist_claims(TIMESTAMPTZ);
DROP FUNCTION claim_waitlist(INTEGER, INTEGER, TIMESTAMPTZ);
DROP FUNCTION notify_next_waitlist(INTEGER, TIMESTAMPTZ, INTEGER);
DROP FUNCTION join_waitlist(INTEGER, INTEGER);
DROP VIEW v_waitlist_queue;
-- The table "waitlist" and its rows are kept on purpose (nothing is deleted); the app simply does not use it any more.

-- ---------------------------------------------------------------------------
-- 7. Admin: a warning about a listing or a student is an official message of kind WARNING
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION admin_send_message(
    p_admin_id INTEGER, p_student_id INTEGER, p_body TEXT, p_kind TEXT DEFAULT 'MESSAGE',
    p_report_id INTEGER DEFAULT NULL, p_listing_id INTEGER DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_id INTEGER;
BEGIN
    IF p_kind NOT IN ('MESSAGE', 'CLARIFICATION', 'WARNING') THEN
        RAISE EXCEPTION 'Unknown message type' USING ERRCODE = 'check_violation';
    END IF;
    IF p_body IS NULL OR char_length(btrim(p_body)) < 1 THEN
        RAISE EXCEPTION 'Write a message first' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM student WHERE student_id = p_student_id) THEN
        RAISE EXCEPTION 'Student not found' USING ERRCODE = 'no_data_found';
    END IF;
    INSERT INTO admin_message (student_id, sender_type, admin_id, report_id, listing_id, kind, body)
    VALUES (p_student_id, 'ADMIN', p_admin_id, p_report_id, p_listing_id, p_kind, btrim(p_body))
    RETURNING admin_message_id INTO v_id;
    IF p_kind = 'WARNING' THEN
        UPDATE student SET warning_count = warning_count + 1 WHERE student_id = p_student_id;
    END IF;
    INSERT INTO admin_action (admin_id, action, report_id, student_id, listing_id, reason)
    VALUES (p_admin_id, CASE WHEN p_kind = 'WARNING' THEN 'WARN_USER' ELSE 'SEND_MESSAGE' END,
            p_report_id, p_student_id, p_listing_id, left(btrim(p_body), 1000));
    PERFORM tf_notify(p_student_id, 'ADMIN_MESSAGE',
        CASE p_kind WHEN 'WARNING' THEN 'Warning from the administrators'
                    WHEN 'CLARIFICATION' THEN 'The administrators need more information'
                    ELSE 'Message from the administrators' END,
        left(btrim(p_body), 300), p_listing_id);
    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Once, when this migration runs: tell students about swap matches that already exist (each is told only once).
-- ---------------------------------------------------------------------------
SELECT notify_swap_matches();
