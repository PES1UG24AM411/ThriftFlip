-- 010_direct_swaps.sql
-- Direct two-student swaps ("swap proposals").
--
-- WHY: the old swap tables (swap_preference / swap_request, migration 001/005) only modelled matches found
-- automatically by find_swap_cycles(). A student could not propose a swap on a listing they were looking at,
-- there was no settlement amount, and a finished swap was pushed through the purchase/payment state machine
-- (PAYMENT_HELD, ...), which makes no sense for a book-for-book exchange.
-- The multi-way machinery (swap_preference, swap_request, find_swap_cycles, propose_swap_cycle,
-- respond_swap_request) is left untouched.
--
-- WORKFLOW (all functions run in the caller's transaction and lock the rows they change):
--   propose_swap          proposer offers ONE OF THEIR OWN listings for the receiver's listing   -> PENDING
--   respond_swap_proposal receiver accepts (-> ACCEPTED, both listings RESERVED) or rejects (-> REJECTED);
--                         the proposer can cancel a PENDING proposal, either student can cancel an ACCEPTED one
--   confirm_swap_exchange after meeting in person EACH student confirms "we exchanged the books";
--                         when both did the proposal becomes COMPLETED, both listings SWAPPED and ONE
--                         transaction (type SWAP, state RELEASED) is written for the history/reputation.
-- Money: the optional settlement amount is only an agreement between the two students. THRIFTFLIP does not
-- process payments; the students settle it in person.

CREATE TABLE swap_proposal (
    swap_proposal_id SERIAL PRIMARY KEY, -- surrogate key of the proposal
    proposer_id INTEGER NOT NULL REFERENCES student(student_id), -- student who proposes the swap
    receiver_id INTEGER NOT NULL REFERENCES student(student_id), -- owner of the requested listing, answers the proposal
    offered_listing_id INTEGER NOT NULL REFERENCES listing(listing_id), -- proposer's own listing that is offered
    requested_listing_id INTEGER NOT NULL REFERENCES listing(listing_id), -- receiver's listing the proposer wants
    settlement_amount NUMERIC(10,2) NOT NULL DEFAULT 0, -- extra money agreed between the students (0 = plain swap)
    settlement_payer TEXT, -- PROPOSER or RECEIVER pays the settlement amount (NULL when it is 0)
    message TEXT, -- optional note to the receiver
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, ACCEPTED, REJECTED, CANCELLED or COMPLETED
    proposer_confirmed_at TIMESTAMPTZ, -- proposer confirmed the books were exchanged
    receiver_confirmed_at TIMESTAMPTZ, -- receiver confirmed the books were exchanged
    responded_at TIMESTAMPTZ, -- time the receiver answered or the proposal was cancelled
    completed_at TIMESTAMPTZ, -- time both students had confirmed
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), -- time the proposal was made
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now() -- last change
);

ALTER TABLE swap_proposal ADD CONSTRAINT ck_swap_proposal_status CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'COMPLETED'));
ALTER TABLE swap_proposal ADD CONSTRAINT ck_swap_proposal_parties CHECK (proposer_id <> receiver_id);
ALTER TABLE swap_proposal ADD CONSTRAINT ck_swap_proposal_listings CHECK (offered_listing_id <> requested_listing_id);
ALTER TABLE swap_proposal ADD CONSTRAINT ck_swap_proposal_amount CHECK (settlement_amount >= 0 AND settlement_amount <= 100000);
ALTER TABLE swap_proposal ADD CONSTRAINT ck_swap_proposal_payer CHECK (
    (settlement_amount = 0 AND settlement_payer IS NULL) OR (settlement_amount > 0 AND settlement_payer IN ('PROPOSER', 'RECEIVER')));
ALTER TABLE swap_proposal ADD CONSTRAINT ck_swap_proposal_message CHECK (message IS NULL OR char_length(message) <= 500);
ALTER TABLE swap_proposal ADD CONSTRAINT ck_swap_proposal_completed CHECK (
    (status = 'COMPLETED') = (completed_at IS NOT NULL AND proposer_confirmed_at IS NOT NULL AND receiver_confirmed_at IS NOT NULL));
ALTER TABLE swap_proposal ADD CONSTRAINT ck_swap_proposal_confirm_state CHECK (
    (proposer_confirmed_at IS NULL AND receiver_confirmed_at IS NULL) OR status IN ('ACCEPTED', 'COMPLETED', 'CANCELLED'));

-- the same pair of listings can have only one open proposal at a time
CREATE UNIQUE INDEX uq_swap_proposal_open_pair ON swap_proposal (offered_listing_id, requested_listing_id) WHERE status IN ('PENDING', 'ACCEPTED');
-- a listing can be part of at most ONE accepted swap (as offered or as requested item)
CREATE UNIQUE INDEX uq_swap_proposal_accepted_offered ON swap_proposal (offered_listing_id) WHERE status = 'ACCEPTED';
CREATE UNIQUE INDEX uq_swap_proposal_accepted_requested ON swap_proposal (requested_listing_id) WHERE status = 'ACCEPTED';
CREATE INDEX idx_swap_proposal_proposer ON swap_proposal (proposer_id, status);
CREATE INDEX idx_swap_proposal_receiver ON swap_proposal (receiver_id, status);
CREATE INDEX idx_swap_proposal_requested ON swap_proposal (requested_listing_id);

-- a completed swap proposal produces exactly one transaction (the unique index makes a second one impossible)
ALTER TABLE transactions ADD COLUMN swap_proposal_id INTEGER REFERENCES swap_proposal(swap_proposal_id); -- direct swap that produced this transaction
CREATE UNIQUE INDEX uq_tx_swap_proposal ON transactions (swap_proposal_id) WHERE swap_proposal_id IS NOT NULL;
ALTER TABLE transactions DROP CONSTRAINT ck_tx_swap_link;
ALTER TABLE transactions ADD CONSTRAINT ck_tx_swap_link CHECK (
    (transaction_type = 'SWAP') = (swap_request_id IS NOT NULL OR swap_proposal_id IS NOT NULL)
    AND NOT (swap_request_id IS NOT NULL AND swap_proposal_id IS NOT NULL));

-- two new notification types
ALTER TABLE notification DROP CONSTRAINT ck_notification_type;
ALTER TABLE notification ADD CONSTRAINT ck_notification_type CHECK (type IN (
    'OUTBID', 'AUCTION_WON', 'AUCTION_SOLD', 'AUCTION_ENDING', 'NEW_OFFER', 'OFFER_ACCEPTED', 'SWAP_MATCH',
    'WAITLIST_AVAILABLE', 'PRICE_ALERT', 'PURCHASE', 'TRANSACTION_UPDATE', 'MESSAGE', 'REPORT_UPDATE', 'LISTING_SOLD',
    'SWAP_PROPOSAL', 'SWAP_UPDATE'));

-- ---------------------------------------------------------------------------
-- propose_swap
-- ---------------------------------------------------------------------------
CREATE FUNCTION propose_swap(
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
    IF v_req.seller_id = p_proposer_id THEN
        RAISE EXCEPTION 'You cannot swap with yourself' USING ERRCODE = 'check_violation';
    END IF;
    IF v_off.seller_id <> p_proposer_id THEN
        RAISE EXCEPTION 'You can only offer a book that you own' USING ERRCODE = 'check_violation';
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
    IF v_amount > 0 AND p_payer NOT IN ('PROPOSER', 'RECEIVER') THEN
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

-- ---------------------------------------------------------------------------
-- respond_swap_proposal: p_action is 'accept', 'reject' or 'cancel'. Returns the new status.
-- ---------------------------------------------------------------------------
CREATE FUNCTION respond_swap_proposal(p_proposal_id INTEGER, p_student_id INTEGER, p_action TEXT)
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
        PERFORM notify_next_waitlist(v_p.offered_listing_id);
        PERFORM notify_next_waitlist(v_p.requested_listing_id);
    END IF;
    UPDATE swap_proposal SET status = 'CANCELLED', responded_at = now(), updated_at = now() WHERE swap_proposal_id = p_proposal_id;
    PERFORM tf_notify(CASE WHEN p_student_id = v_p.proposer_id THEN v_p.receiver_id ELSE v_p.proposer_id END,
        'SWAP_UPDATE', 'Swap cancelled',
        'The swap "' || v_off.title || '" for "' || v_req.title || '" was cancelled.', v_p.requested_listing_id);
    RETURN 'CANCELLED';
END;
$$;

-- ---------------------------------------------------------------------------
-- confirm_swap_exchange: each student confirms once that the books were handed over.
-- Returns 'WAITING' (the other student still has to confirm) or 'COMPLETED'.
-- Repeating the call is harmless: a second confirmation by the same student changes nothing, and a
-- COMPLETED proposal is rejected, so the transaction (and the reputation it gives) can exist only once.
-- ---------------------------------------------------------------------------
CREATE FUNCTION confirm_swap_exchange(p_proposal_id INTEGER, p_student_id INTEGER)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_p swap_proposal%ROWTYPE;
    v_off listing%ROWTYPE;
    v_req listing%ROWTYPE;
BEGIN
    SELECT * INTO v_p FROM swap_proposal WHERE swap_proposal_id = p_proposal_id;
    IF NOT FOUND OR p_student_id NOT IN (v_p.proposer_id, v_p.receiver_id) THEN
        RAISE EXCEPTION 'Swap proposal not found' USING ERRCODE = 'no_data_found';
    END IF;
    PERFORM 1 FROM listing WHERE listing_id IN (v_p.offered_listing_id, v_p.requested_listing_id) ORDER BY listing_id FOR UPDATE;
    SELECT * INTO v_p FROM swap_proposal WHERE swap_proposal_id = p_proposal_id FOR UPDATE;
    IF v_p.status <> 'ACCEPTED' THEN
        RAISE EXCEPTION 'Only an accepted swap can be confirmed (this one is %)', lower(v_p.status) USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_off FROM listing WHERE listing_id = v_p.offered_listing_id;
    SELECT * INTO v_req FROM listing WHERE listing_id = v_p.requested_listing_id;

    IF p_student_id = v_p.proposer_id THEN
        IF v_p.proposer_confirmed_at IS NOT NULL THEN RETURN 'WAITING'; END IF;
        UPDATE swap_proposal SET proposer_confirmed_at = now(), updated_at = now() WHERE swap_proposal_id = p_proposal_id;
        v_p.proposer_confirmed_at := now();
    ELSE
        IF v_p.receiver_confirmed_at IS NOT NULL THEN RETURN 'WAITING'; END IF;
        UPDATE swap_proposal SET receiver_confirmed_at = now(), updated_at = now() WHERE swap_proposal_id = p_proposal_id;
        v_p.receiver_confirmed_at := now();
    END IF;

    IF v_p.proposer_confirmed_at IS NULL OR v_p.receiver_confirmed_at IS NULL THEN
        PERFORM tf_notify(CASE WHEN p_student_id = v_p.proposer_id THEN v_p.receiver_id ELSE v_p.proposer_id END,
            'SWAP_UPDATE', 'Swap: please confirm',
            'The other student says the books were exchanged. Confirm in THRIFTFLIP if that is true.', v_p.requested_listing_id);
        RETURN 'WAITING';
    END IF;

    UPDATE swap_proposal SET status = 'COMPLETED', completed_at = now(), updated_at = now() WHERE swap_proposal_id = p_proposal_id;
    UPDATE listing SET status = 'SWAPPED', open_to_swap = false
    WHERE listing_id IN (v_p.offered_listing_id, v_p.requested_listing_id);
    -- one finished transaction for the history, the counts and the ratings
    INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, transaction_type, swap_proposal_id, state)
    VALUES (v_p.requested_listing_id, v_p.proposer_id, v_p.receiver_id, v_p.settlement_amount, 'SWAP', v_p.swap_proposal_id, 'RELEASED');
    PERFORM tf_notify(v_p.proposer_id, 'SWAP_UPDATE', 'Swap completed',
        'Your swap for "' || v_req.title || '" is complete. You can now rate the other student.', v_p.requested_listing_id);
    PERFORM tf_notify(v_p.receiver_id, 'SWAP_UPDATE', 'Swap completed',
        'Your swap for "' || v_off.title || '" is complete. You can now rate the other student.', v_p.offered_listing_id);
    RETURN 'COMPLETED';
END;
$$;

-- ---------------------------------------------------------------------------
-- A PENDING proposal cannot survive when one of its books stops being available: the listing is bought, reserved
-- by another swap, sold, swapped or removed (status leaves ACTIVE), or the owner of the REQUESTED listing switches
-- "open to swap" off. The proposer is told. (An ACCEPTED proposal keeps its listings RESERVED, so nothing else
-- can take them.)
-- ---------------------------------------------------------------------------
CREATE FUNCTION listing_cancels_swap_proposals() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_gone BOOLEAN := (OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE');
    v_closed BOOLEAN := (OLD.open_to_swap AND NOT NEW.open_to_swap);
BEGIN
    IF NOT (v_gone OR v_closed) THEN
        RETURN NULL;
    END IF;
    WITH c AS (
        UPDATE swap_proposal SET status = 'CANCELLED', responded_at = now(), updated_at = now()
        WHERE status = 'PENDING'
          AND ((v_gone AND (offered_listing_id = NEW.listing_id OR requested_listing_id = NEW.listing_id))
            OR (v_closed AND requested_listing_id = NEW.listing_id))
        RETURNING proposer_id, requested_listing_id
    )
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT proposer_id, 'SWAP_UPDATE', 'Swap proposal closed',
           'A book in your swap proposal is no longer available for swapping.', requested_listing_id FROM c;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_listing_cancels_swap_proposals
AFTER UPDATE OF status, open_to_swap ON listing
FOR EACH ROW EXECUTE FUNCTION listing_cancels_swap_proposals();
