-- 005_functions.sql
-- Business logic as stored functions. Every function that changes data runs
-- inside the caller's transaction, so a failure rolls everything back.
-- Functions take an optional p_now parameter (default now()) so that time-dependent
-- behaviour (anti-sniping, auction closing, claim windows) can be tested exactly.
-- Validation failures raise SQLSTATE 23514 (check_violation); the API maps it to HTTP 400/409.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
CREATE FUNCTION tf_notify(p_student_id INTEGER, p_type TEXT, p_title TEXT, p_body TEXT, p_listing_id INTEGER DEFAULT NULL)
RETURNS VOID
LANGUAGE sql AS $$
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    VALUES (p_student_id, p_type, p_title, p_body, p_listing_id);
$$;

-- Allowed transaction transitions (the state machine):
--   PENDING -> PAYMENT_HELD -> HANDED_OFF -> CONFIRMED -> RELEASED
--   PENDING / PAYMENT_HELD -> CANCELLED
CREATE FUNCTION is_valid_transition(p_old TEXT, p_new TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
    SELECT (p_old = 'PENDING'      AND p_new IN ('PAYMENT_HELD', 'CANCELLED'))
        OR (p_old = 'PAYMENT_HELD' AND p_new IN ('HANDED_OFF', 'CANCELLED'))
        OR (p_old = 'HANDED_OFF'   AND p_new = 'CONFIRMED')
        OR (p_old = 'CONFIRMED'    AND p_new = 'RELEASED');
$$;

-- ---------------------------------------------------------------------------
-- AUCTIONS
-- ---------------------------------------------------------------------------

-- place_bid: lock the auction row, insert the bid (trigger validate_bid checks all rules),
-- raise the price, and apply anti-sniping: a bid in the last 60 seconds moves the end time
-- forward by 2 minutes. FOR UPDATE makes simultaneous bids on one auction run one after the other.
CREATE FUNCTION place_bid(p_auction_id INTEGER, p_bidder_id INTEGER, p_amount NUMERIC, p_now TIMESTAMPTZ DEFAULT now())
RETURNS TABLE (out_bid_id INTEGER, out_end_time TIMESTAMPTZ, out_extended BOOLEAN, out_price NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE
    v_auction auction%ROWTYPE;
    v_bid_id INTEGER;
    v_new_end TIMESTAMPTZ;
    v_extended BOOLEAN := false;
    v_prev_bidder INTEGER;
    v_title TEXT;
BEGIN
    SELECT * INTO v_auction FROM auction WHERE auction_id = p_auction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Auction % not found', p_auction_id USING ERRCODE = 'no_data_found';
    END IF;

    v_prev_bidder := v_auction.highest_bidder_id;
    v_new_end := v_auction.end_time;

    INSERT INTO bid (auction_id, bidder_id, amount, placed_at)
    VALUES (p_auction_id, p_bidder_id, p_amount, p_now)
    RETURNING bid_id INTO v_bid_id;

    -- Anti-sniping (validate_bid already guaranteed p_now < end_time)
    IF v_auction.end_time - p_now <= INTERVAL '60 seconds' THEN
        v_new_end := v_auction.end_time + INTERVAL '2 minutes';
        v_extended := true;
    END IF;

    UPDATE auction
    SET current_price = p_amount,
        highest_bidder_id = p_bidder_id,
        end_time = v_new_end,
        extension_count = extension_count + CASE WHEN v_extended THEN 1 ELSE 0 END
    WHERE auction_id = p_auction_id;

    IF v_prev_bidder IS NOT NULL AND v_prev_bidder <> p_bidder_id THEN
        SELECT title INTO v_title FROM listing WHERE listing_id = v_auction.listing_id;
        PERFORM tf_notify(v_prev_bidder, 'OUTBID', 'You were outbid',
                          'Someone bid ' || p_amount || ' on "' || v_title || '".', v_auction.listing_id);
    END IF;

    out_bid_id := v_bid_id;
    out_end_time := v_new_end;
    out_extended := v_extended;
    out_price := p_amount;
    RETURN NEXT;
END;
$$;

-- cancel_bid: a bidder may cancel only a bid that is not the current highest bid
-- while the auction is still active.
CREATE FUNCTION cancel_bid(p_bid_id INTEGER, p_bidder_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_bid bid%ROWTYPE;
    v_auction auction%ROWTYPE;
BEGIN
    SELECT * INTO v_bid FROM bid WHERE bid_id = p_bid_id;
    IF NOT FOUND OR v_bid.bidder_id <> p_bidder_id THEN
        RAISE EXCEPTION 'Bid not found' USING ERRCODE = 'no_data_found';
    END IF;
    SELECT * INTO v_auction FROM auction WHERE auction_id = v_bid.auction_id FOR UPDATE;
    IF v_auction.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Auction is no longer active' USING ERRCODE = 'check_violation';
    END IF;
    IF v_bid.status <> 'VALID' THEN
        RAISE EXCEPTION 'Bid is already cancelled' USING ERRCODE = 'check_violation';
    END IF;
    IF v_bid.amount >= v_auction.current_price THEN
        RAISE EXCEPTION 'The current highest bid cannot be cancelled' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE bid SET status = 'CANCELLED' WHERE bid_id = p_bid_id;
END;
$$;

-- close_auction: after end_time, mark the auction CLOSED, choose the winner (highest bidder)
-- and open an AUCTION_WIN transaction. Returns the transaction id, or NULL when nobody bid.
CREATE FUNCTION close_auction(p_auction_id INTEGER, p_now TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_auction auction%ROWTYPE;
    v_listing listing%ROWTYPE;
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

    IF v_auction.highest_bidder_id IS NULL THEN
        UPDATE auction SET status = 'CLOSED', closed_at = p_now WHERE auction_id = p_auction_id;
        UPDATE listing SET status = 'REMOVED' WHERE listing_id = v_listing.listing_id;   -- unsold: withdrawn
        RETURN NULL;
    END IF;

    UPDATE auction
    SET status = 'CLOSED', winner_id = highest_bidder_id, closed_at = p_now
    WHERE auction_id = p_auction_id;

    INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, transaction_type)
    VALUES (v_listing.listing_id, v_auction.highest_bidder_id, v_listing.seller_id, v_auction.current_price, 'AUCTION_WIN')
    RETURNING transaction_id INTO v_tx_id;

    UPDATE listing SET status = 'RESERVED' WHERE listing_id = v_listing.listing_id;

    PERFORM tf_notify(v_auction.highest_bidder_id, 'AUCTION_WON', 'You won the auction',
                      'You won "' || v_listing.title || '" for ' || v_auction.current_price || '.', v_listing.listing_id);
    PERFORM tf_notify(v_listing.seller_id, 'AUCTION_SOLD', 'Your auction ended',
                      '"' || v_listing.title || '" sold for ' || v_auction.current_price || '.', v_listing.listing_id);
    RETURN v_tx_id;
END;
$$;

-- close_expired_auctions: closes every ACTIVE auction whose end_time has passed.
-- Called by the API (and the admin dashboard) so no external scheduler is needed.
CREATE FUNCTION close_expired_auctions(p_now TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_id INTEGER;
    v_count INTEGER := 0;
BEGIN
    FOR v_id IN SELECT auction_id FROM auction WHERE status = 'ACTIVE' AND end_time <= p_now ORDER BY auction_id LOOP
        PERFORM close_auction(v_id, p_now);
        v_count := v_count + 1;
    END LOOP;
    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- FIXED-PRICE PURCHASE AND OFFERS
-- ---------------------------------------------------------------------------

-- create_purchase: lock the listing row so two buyers cannot buy the same item,
-- respect a waitlist claim window, open a PURCHASE transaction and reserve the listing.
CREATE FUNCTION create_purchase(p_listing_id INTEGER, p_buyer_id INTEGER, p_now TIMESTAMPTZ DEFAULT now())
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
    IF EXISTS (SELECT 1 FROM waitlist
               WHERE listing_id = p_listing_id AND status = 'NOTIFIED'
                 AND claim_expires_at > p_now AND student_id <> p_buyer_id) THEN
        RAISE EXCEPTION 'Listing is held for a waitlisted student' USING ERRCODE = 'check_violation';
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

-- accept_offer: the seller accepts one offer; the others are rejected; a transaction is opened
-- at the offered price.
CREATE FUNCTION accept_offer(p_offer_id INTEGER, p_seller_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_offer offer%ROWTYPE;
    v_listing listing%ROWTYPE;
    v_tx_id INTEGER;
BEGIN
    SELECT * INTO v_offer FROM offer WHERE offer_id = p_offer_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Offer not found' USING ERRCODE = 'no_data_found';
    END IF;
    SELECT * INTO v_listing FROM listing WHERE listing_id = v_offer.listing_id FOR UPDATE;
    IF v_listing.seller_id <> p_seller_id THEN
        RAISE EXCEPTION 'Only the seller can accept offers' USING ERRCODE = 'check_violation';
    END IF;
    IF v_offer.status <> 'PENDING' OR v_listing.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Offer or listing is no longer available' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, transaction_type)
    VALUES (v_listing.listing_id, v_offer.buyer_id, v_listing.seller_id, v_offer.amount, 'PURCHASE')
    RETURNING transaction_id INTO v_tx_id;

    UPDATE offer SET status = 'ACCEPTED', responded_at = now() WHERE offer_id = p_offer_id;
    UPDATE offer SET status = 'REJECTED', responded_at = now()
    WHERE listing_id = v_listing.listing_id AND status = 'PENDING' AND offer_id <> p_offer_id;
    UPDATE listing SET status = 'RESERVED' WHERE listing_id = v_listing.listing_id;

    PERFORM tf_notify(v_offer.buyer_id, 'OFFER_ACCEPTED', 'Offer accepted',
                      'Your offer of ' || v_offer.amount || ' for "' || v_listing.title || '" was accepted.', v_listing.listing_id);
    RETURN v_tx_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRANSACTION STATE MACHINE
-- ---------------------------------------------------------------------------

-- transition_transaction: moves a transaction to a new state. The actor is passed to the
-- triggers with transaction-local settings. Invalid transitions are rejected by the trigger
-- trg_tx_validate_transition, so even a direct UPDATE cannot skip a state.
CREATE FUNCTION transition_transaction(p_transaction_id INTEGER, p_new_state TEXT, p_actor_type TEXT, p_actor_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('app.actor_type', p_actor_type, true);
    PERFORM set_config('app.actor_id', COALESCE(p_actor_id::TEXT, ''), true);
    UPDATE transactions SET state = p_new_state WHERE transaction_id = p_transaction_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Transaction not found' USING ERRCODE = 'no_data_found';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- WAITLIST (FIFO with claim window)
-- ---------------------------------------------------------------------------

-- join_waitlist: only for fixed-price listings that are currently RESERVED (unavailable
-- but may come back if the transaction is cancelled).
CREATE FUNCTION join_waitlist(p_listing_id INTEGER, p_student_id INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_listing listing%ROWTYPE;
    v_id INTEGER;
BEGIN
    SELECT * INTO v_listing FROM listing WHERE listing_id = p_listing_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Listing not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_listing.listing_type <> 'FIXED_PRICE' OR v_listing.status <> 'RESERVED' THEN
        RAISE EXCEPTION 'You can only join the waitlist of a reserved fixed-price listing' USING ERRCODE = 'check_violation';
    END IF;
    IF v_listing.seller_id = p_student_id THEN
        RAISE EXCEPTION 'You cannot wait for your own listing' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM transactions WHERE listing_id = p_listing_id AND buyer_id = p_student_id
               AND state NOT IN ('RELEASED', 'CANCELLED')) THEN
        RAISE EXCEPTION 'You already have an active transaction for this listing' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO waitlist (listing_id, student_id) VALUES (p_listing_id, p_student_id)
    ON CONFLICT (listing_id, student_id) DO UPDATE
        SET status = 'WAITING', joined_at = now(), notified_at = NULL, claim_expires_at = NULL
        WHERE waitlist.status IN ('EXPIRED', 'CANCELLED')
    RETURNING waitlist_id INTO v_id;

    IF v_id IS NULL THEN
        RAISE EXCEPTION 'You are already on this waitlist' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN v_id;
END;
$$;

-- notify_next_waitlist: when a listing is ACTIVE again and nobody holds a live claim,
-- the first WAITING student (FIFO by joined_at) is notified and gets a claim window.
CREATE FUNCTION notify_next_waitlist(p_listing_id INTEGER, p_now TIMESTAMPTZ DEFAULT now(), p_claim_minutes INTEGER DEFAULT 30)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_id INTEGER;
    v_student INTEGER;
    v_title TEXT;
BEGIN
    SELECT title INTO v_title FROM listing WHERE listing_id = p_listing_id AND status = 'ACTIVE';
    IF v_title IS NULL THEN
        RETURN NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM waitlist WHERE listing_id = p_listing_id AND status = 'NOTIFIED' AND claim_expires_at > p_now) THEN
        RETURN NULL;
    END IF;

    SELECT waitlist_id, student_id INTO v_id, v_student
    FROM waitlist
    WHERE listing_id = p_listing_id AND status = 'WAITING'
    ORDER BY joined_at, waitlist_id
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_id IS NULL THEN
        RETURN NULL;
    END IF;

    UPDATE waitlist
    SET status = 'NOTIFIED', notified_at = p_now, claim_expires_at = p_now + make_interval(mins => p_claim_minutes)
    WHERE waitlist_id = v_id;

    PERFORM tf_notify(v_student, 'WAITLIST_AVAILABLE', 'Your item is available',
                      '"' || v_title || '" is available. Claim it within ' || p_claim_minutes || ' minutes.', p_listing_id);
    RETURN v_id;
END;
$$;

-- claim_waitlist: the notified student claims the item inside the claim window.
CREATE FUNCTION claim_waitlist(p_waitlist_id INTEGER, p_student_id INTEGER, p_now TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_w waitlist%ROWTYPE;
BEGIN
    SELECT * INTO v_w FROM waitlist WHERE waitlist_id = p_waitlist_id FOR UPDATE;
    IF NOT FOUND OR v_w.student_id <> p_student_id THEN
        RAISE EXCEPTION 'Waitlist entry not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_w.status <> 'NOTIFIED' THEN
        RAISE EXCEPTION 'You have not been offered this item' USING ERRCODE = 'check_violation';
    END IF;
    IF v_w.claim_expires_at <= p_now THEN
        RAISE EXCEPTION 'Your claim window has expired' USING ERRCODE = 'check_violation';
    END IF;
    UPDATE waitlist SET status = 'CLAIMED' WHERE waitlist_id = p_waitlist_id;
    RETURN create_purchase(v_w.listing_id, p_student_id, p_now);
END;
$$;

-- expire_waitlist_claims: claims not used in time become EXPIRED and the next student in line
-- is notified. Returns the number of expired claims.
CREATE FUNCTION expire_waitlist_claims(p_now TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_listing INTEGER;
    v_count INTEGER := 0;
BEGIN
    FOR v_listing IN
        WITH expired AS (
            UPDATE waitlist SET status = 'EXPIRED'
            WHERE status = 'NOTIFIED' AND claim_expires_at <= p_now
            RETURNING listing_id
        )
        SELECT listing_id FROM expired
    LOOP
        v_count := v_count + 1;
        PERFORM notify_next_waitlist(v_listing, p_now);
    END LOOP;
    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- SMART SWAPS
-- ---------------------------------------------------------------------------

-- find_swap_cycles: builds a directed graph and finds cycles with a recursive CTE.
--   node  = ACTIVE, swap-enabled, fixed-price listing
--   edge  = listing A -> listing B when the owner of A listed a swap_preference for the book of B
--           (owner of A wants B). Cycle A -> B -> A is a DIRECT swap, longer cycles are MULTI_WAY.
-- Every student appears once per cycle. Each cycle is reported once (it starts at its smallest listing id).
CREATE FUNCTION find_swap_cycles(p_student_id INTEGER DEFAULT NULL, p_max_length INTEGER DEFAULT 4)
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

-- propose_swap_cycle: turns a cycle (list of listing ids from find_swap_cycles) into swap requests.
-- Request i means: the owner of path[i] receives path[i+1] (the last one receives path[1]).
-- Checks availability, ownership, duplicate and conflicting swaps. The initiator's own
-- agreement (to give away their listing) is recorded immediately.
CREATE FUNCTION propose_swap_cycle(p_path INTEGER[], p_initiator_id INTEGER)
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
           'A ' || CASE WHEN v_n = 2 THEN 'direct' ELSE v_n || '-way' END || ' swap involves your listing "' || l.title || '".',
           l.listing_id
    FROM listing l
    WHERE l.listing_id = ANY (p_path) AND l.seller_id <> p_initiator_id;

    RETURN v_cycle;
END;
$$;

-- respond_swap_request: the owner of the REQUESTED listing accepts or rejects (they give that item away).
-- Rejecting cancels the whole cycle. When every request of the cycle is ACCEPTED, one SWAP
-- transaction per listing is created and the listings are RESERVED.
-- Returns 'REJECTED', 'WAITING' (others must still answer) or 'READY' (transactions created).
CREATE FUNCTION respond_swap_request(p_request_id INTEGER, p_student_id INTEGER, p_accept BOOLEAN)
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
        UPDATE swap_request SET status = 'CANCELLED', responded_at = now()
        WHERE cycle_id = v_req.cycle_id AND swap_request_id <> p_request_id AND status IN ('PENDING', 'ACCEPTED');
        RETURN 'REJECTED';
    END IF;

    UPDATE swap_request SET status = 'ACCEPTED', responded_at = now() WHERE swap_request_id = p_request_id;

    IF EXISTS (SELECT 1 FROM swap_request WHERE cycle_id = v_req.cycle_id AND status <> 'ACCEPTED') THEN
        RETURN 'WAITING';
    END IF;

    INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, transaction_type, swap_request_id)
    SELECT r.requested_listing_id, r.requester_id, l.seller_id, 0, 'SWAP', r.swap_request_id
    FROM swap_request r
    JOIN listing l ON l.listing_id = r.requested_listing_id
    WHERE r.cycle_id = v_req.cycle_id;

    UPDATE listing SET status = 'RESERVED'
    WHERE listing_id IN (SELECT requested_listing_id FROM swap_request WHERE cycle_id = v_req.cycle_id);

    RETURN 'READY';
END;
$$;

-- ---------------------------------------------------------------------------
-- PRICE INTELLIGENCE
-- ---------------------------------------------------------------------------

-- calculate_fair_price: weighted average of four averages taken from finished sales
-- (transactions CONFIRMED/RELEASED, excluding swaps):
--   30 %  same title and author (any edition)
--   25 %  same book edition (same book_id)
--   25 %  same condition within the same subject
--   20 %  same course
-- A component with no data is skipped and the remaining weights are re-scaled to 100 %.
-- historical_min/avg/max describe the same-title sales. NULL when there is no history.
CREATE FUNCTION calculate_fair_price(p_book_id INTEGER, p_item_condition TEXT)
RETURNS TABLE (estimated_price NUMERIC, historical_avg NUMERIC, historical_min NUMERIC, historical_max NUMERIC, sample_size INTEGER)
LANGUAGE sql STABLE AS $$
    WITH target AS (
        SELECT book_id, title, author, subject, course_id FROM book WHERE book_id = p_book_id
    ),
    parts AS (
        SELECT
            AVG(h.amount) FILTER (WHERE h.title = tg.title AND h.author = tg.author) AS avg_title,
            AVG(h.amount) FILTER (WHERE h.book_id = tg.book_id) AS avg_edition,
            AVG(h.amount) FILTER (WHERE h.item_condition = p_item_condition AND h.subject = tg.subject) AS avg_condition,
            AVG(h.amount) FILTER (WHERE tg.course_id IS NOT NULL AND h.course_id = tg.course_id) AS avg_course,
            MIN(h.amount) FILTER (WHERE h.title = tg.title AND h.author = tg.author) AS min_title,
            MAX(h.amount) FILTER (WHERE h.title = tg.title AND h.author = tg.author) AS max_title,
            COUNT(*) FILTER (WHERE h.title = tg.title AND h.author = tg.author) AS n_title
        FROM target tg
        CROSS JOIN v_price_history h
    )
    SELECT
        ROUND(
            (COALESCE(avg_title * 0.30, 0) + COALESCE(avg_edition * 0.25, 0)
             + COALESCE(avg_condition * 0.25, 0) + COALESCE(avg_course * 0.20, 0))
            / NULLIF(
                (CASE WHEN avg_title IS NOT NULL THEN 0.30 ELSE 0 END
                 + CASE WHEN avg_edition IS NOT NULL THEN 0.25 ELSE 0 END
                 + CASE WHEN avg_condition IS NOT NULL THEN 0.25 ELSE 0 END
                 + CASE WHEN avg_course IS NOT NULL THEN 0.20 ELSE 0 END), 0),
            2),
        ROUND(avg_title, 2),
        min_title,
        max_title,
        n_title::INTEGER
    FROM parts;
$$;

-- ---------------------------------------------------------------------------
-- MODERATION
-- ---------------------------------------------------------------------------

-- resolve_report: an admin handles an OPEN report.
--   DISMISSED       : nothing happens
--   WARNED          : warning_count + 1 for the reported student
--   LISTING_REMOVED : the reported listing is set to REMOVED
--   USER_SUSPENDED  : the student is SUSPENDED and all their ACTIVE listings are REMOVED
CREATE FUNCTION resolve_report(p_report_id INTEGER, p_admin_id INTEGER, p_action TEXT)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_report report%ROWTYPE;
BEGIN
    IF p_action NOT IN ('DISMISSED', 'WARNED', 'LISTING_REMOVED', 'USER_SUSPENDED') THEN
        RAISE EXCEPTION 'Unknown moderation action %', p_action USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_report FROM report WHERE report_id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_report.status <> 'OPEN' THEN
        RAISE EXCEPTION 'Report was already handled' USING ERRCODE = 'check_violation';
    END IF;
    IF p_action = 'LISTING_REMOVED' AND v_report.reported_listing_id IS NULL THEN
        RAISE EXCEPTION 'This report has no listing to remove' USING ERRCODE = 'check_violation';
    END IF;

    IF p_action = 'WARNED' THEN
        UPDATE student SET warning_count = warning_count + 1 WHERE student_id = v_report.reported_student_id;
    ELSIF p_action = 'LISTING_REMOVED' THEN
        UPDATE listing SET status = 'REMOVED' WHERE listing_id = v_report.reported_listing_id AND status IN ('ACTIVE', 'RESERVED');
    ELSIF p_action = 'USER_SUSPENDED' THEN
        UPDATE student SET status = 'SUSPENDED' WHERE student_id = v_report.reported_student_id;
        UPDATE listing SET status = 'REMOVED' WHERE seller_id = v_report.reported_student_id AND status = 'ACTIVE';
    END IF;

    UPDATE report SET status = p_action, resolved_by = p_admin_id, resolved_at = now() WHERE report_id = p_report_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- E-MAIL VERIFICATION AND PASSWORD RESET (single-use, expiring tokens)
-- The application sends the secret token by e-mail and stores only its SHA-256 hash.
-- ---------------------------------------------------------------------------

-- create_auth_token: replaces any unused token of the same purpose for that student.
CREATE FUNCTION create_auth_token(p_student_id INTEGER, p_token_hash TEXT, p_purpose TEXT, p_minutes INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM auth_token WHERE student_id = p_student_id AND purpose = p_purpose AND used_at IS NULL;
    INSERT INTO auth_token (token_hash, student_id, purpose, expires_at)
    VALUES (p_token_hash, p_student_id, p_purpose, now() + make_interval(mins => p_minutes));
END;
$$;

-- consume_auth_token: marks the token used and returns its student, or NULL when the token is
-- unknown, already used or expired. One UPDATE makes "use once" safe even with simultaneous requests.
CREATE FUNCTION consume_auth_token(p_token_hash TEXT, p_purpose TEXT)
RETURNS INTEGER
LANGUAGE sql AS $$
    UPDATE auth_token SET used_at = now()
    WHERE token_hash = p_token_hash AND purpose = p_purpose AND used_at IS NULL AND expires_at > now()
    RETURNING student_id;
$$;

CREATE FUNCTION verify_student_email(p_token_hash TEXT)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_student INTEGER;
BEGIN
    v_student := consume_auth_token(p_token_hash, 'VERIFY_EMAIL');
    IF v_student IS NULL THEN
        RETURN NULL;
    END IF;
    UPDATE student SET email_verified = true, email_verified_at = now() WHERE student_id = v_student;
    RETURN v_student;
END;
$$;

CREATE FUNCTION reset_student_password(p_token_hash TEXT, p_new_password_hash TEXT)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_student INTEGER;
BEGIN
    v_student := consume_auth_token(p_token_hash, 'RESET_PASSWORD');
    IF v_student IS NULL THEN
        RETURN NULL;
    END IF;
    UPDATE student SET password_hash = p_new_password_hash WHERE student_id = v_student;
    DELETE FROM auth_token WHERE student_id = v_student;   -- every other outstanding token dies too
    RETURN v_student;
END;
$$;

-- ---------------------------------------------------------------------------
-- MARK AS SOLD and RECENTLY VIEWED
-- ---------------------------------------------------------------------------

-- mark_listing_sold: the seller sold the book outside the app. The listing leaves the active
-- marketplace, pending offers are rejected, and students who favorited it are told.
CREATE FUNCTION mark_listing_sold(p_listing_id INTEGER, p_seller_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_listing listing%ROWTYPE;
BEGIN
    SELECT * INTO v_listing FROM listing WHERE listing_id = p_listing_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Listing not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_listing.seller_id <> p_seller_id THEN
        RAISE EXCEPTION 'Only the seller can mark a listing as sold' USING ERRCODE = 'check_violation';
    END IF;
    IF v_listing.listing_type <> 'FIXED_PRICE' THEN
        RAISE EXCEPTION 'Only fixed-price listings can be marked as sold' USING ERRCODE = 'check_violation';
    END IF;
    IF v_listing.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Only active listings can be marked as sold' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM swap_request
               WHERE status IN ('PENDING', 'ACCEPTED')
                 AND (offered_listing_id = p_listing_id OR requested_listing_id = p_listing_id)) THEN
        RAISE EXCEPTION 'This listing is part of a pending swap request' USING ERRCODE = 'check_violation';
    END IF;

    UPDATE listing SET status = 'SOLD', open_to_swap = false WHERE listing_id = p_listing_id;
    UPDATE offer SET status = 'REJECTED', responded_at = now() WHERE listing_id = p_listing_id AND status = 'PENDING';

    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT w.student_id, 'LISTING_SOLD', 'A favorite was sold', '"' || v_listing.title || '" has been sold.', p_listing_id
    FROM wishlist w
    WHERE w.listing_id = p_listing_id AND w.student_id <> p_seller_id;
END;
$$;

-- touch_recently_viewed: remembers the last 20 listings a student looked at.
CREATE FUNCTION touch_recently_viewed(p_student_id INTEGER, p_listing_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO recently_viewed (student_id, listing_id) VALUES (p_student_id, p_listing_id)
    ON CONFLICT (student_id, listing_id) DO UPDATE SET viewed_at = now();

    DELETE FROM recently_viewed
    WHERE student_id = p_student_id
      AND listing_id NOT IN (SELECT listing_id FROM recently_viewed
                             WHERE student_id = p_student_id ORDER BY viewed_at DESC LIMIT 20);
END;
$$;
