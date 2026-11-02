-- 006_triggers.sql
-- Triggers enforce rules that CHECK constraints cannot express (they need other tables)
-- and keep derived data up to date. They run for every writer, not only for the API.

-- ---------------------------------------------------------------------------
-- student rules (B.Tech marketplace):
--   * the campus comes from the chosen department
--   * the e-mail must belong to an allowed college domain (table college_email_domain)
--   * a changed e-mail has to be verified again
--   * the semester can never go backwards
--   * the department can only be changed in the first year (semesters 1 and 2)
-- ---------------------------------------------------------------------------
CREATE FUNCTION validate_student() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_campus INTEGER;
    v_domain TEXT;
    v_check_email BOOLEAN;
BEGIN
    SELECT campus_id INTO v_campus FROM department WHERE department_id = NEW.department_id;
    IF v_campus IS NULL THEN
        RAISE EXCEPTION 'Unknown department' USING ERRCODE = 'check_violation';
    END IF;
    NEW.campus_id := v_campus;

    IF TG_OP = 'INSERT' THEN
        v_check_email := true;
    ELSE
        v_check_email := NEW.email IS DISTINCT FROM OLD.email;
    END IF;
    IF v_check_email THEN
        v_domain := lower(split_part(NEW.email, '@', 2));
        IF NOT EXISTS (SELECT 1 FROM college_email_domain d WHERE v_domain = d.domain OR v_domain LIKE '%.' || d.domain) THEN
            RAISE EXCEPTION 'Please use your college e-mail address' USING ERRCODE = 'check_violation';
        END IF;
        IF TG_OP = 'UPDATE' THEN
            NEW.email_verified := false;
            NEW.email_verified_at := NULL;
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.semester < OLD.semester THEN
            RAISE EXCEPTION 'The semester cannot go backwards' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.department_id <> OLD.department_id AND OLD.semester > 2 THEN
            RAISE EXCEPTION 'The department can only be changed in the first year (semesters 1 and 2)' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_student_validate
BEFORE INSERT OR UPDATE OF department_id, semester, email ON student
FOR EACH ROW EXECUTE FUNCTION validate_student();

-- ---------------------------------------------------------------------------
-- listing_image: at most 5 photos per listing, uploaded by the seller of that listing
-- ---------------------------------------------------------------------------
CREATE FUNCTION listing_image_rules() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM listing WHERE listing_id = NEW.listing_id FOR UPDATE;   -- serialises simultaneous uploads
    IF (SELECT COUNT(*) FROM listing_image WHERE listing_id = NEW.listing_id) >= 5 THEN
        RAISE EXCEPTION 'A listing can have at most 5 photos' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM image i JOIN listing l ON l.seller_id = i.owner_id
                   WHERE i.image_id = NEW.image_id AND i.purpose = 'LISTING' AND l.listing_id = NEW.listing_id) THEN
        RAISE EXCEPTION 'A listing photo must be uploaded by the seller of the listing' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_image_rules
BEFORE INSERT ON listing_image
FOR EACH ROW EXECUTE FUNCTION listing_image_rules();

-- ---------------------------------------------------------------------------
-- listing: seller must be active, build the full-text document, keep updated_at
-- Weights: A title, B author/subject/ISBN/course, C description and edition
-- ---------------------------------------------------------------------------
CREATE FUNCTION listing_before_write() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_author TEXT;
    v_subject TEXT;
    v_isbn TEXT;
    v_edition INTEGER;
    v_course_code TEXT;
    v_course_name TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF (SELECT status FROM student WHERE student_id = NEW.seller_id) <> 'ACTIVE' THEN
            RAISE EXCEPTION 'Suspended students cannot create listings' USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        NEW.updated_at := now();
    END IF;

    IF NEW.book_id IS NOT NULL THEN
        SELECT b.author, b.subject, b.isbn, b.edition, c.code, c.name
        INTO v_author, v_subject, v_isbn, v_edition, v_course_code, v_course_name
        FROM book b
        LEFT JOIN course c ON c.course_id = b.course_id
        WHERE b.book_id = NEW.book_id;
    END IF;

    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A')
        || setweight(to_tsvector('english', COALESCE(v_author, '') || ' ' || COALESCE(v_subject, '') || ' '
                                            || COALESCE(v_isbn, '') || ' ' || COALESCE(v_course_code, '') || ' '
                                            || COALESCE(v_course_name, '')), 'B')
        || setweight(to_tsvector('english', COALESCE(NEW.description, '') || ' '
                                            || CASE WHEN v_edition IS NULL THEN '' ELSE 'edition ' || v_edition END), 'C');
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_before_write
BEFORE INSERT OR UPDATE ON listing
FOR EACH ROW EXECUTE FUNCTION listing_before_write();

-- ---------------------------------------------------------------------------
-- listing: price alerts. When an ACTIVE listing of a watched book appears (or its price drops
-- or it becomes active again) at or below a student's max_price, notify and deactivate the alert.
-- ---------------------------------------------------------------------------
CREATE FUNCTION listing_price_alerts() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_relevant BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_relevant := true;
    ELSE
        v_relevant := OLD.price IS DISTINCT FROM NEW.price OR OLD.status <> 'ACTIVE';
    END IF;
    IF v_relevant AND NEW.status = 'ACTIVE' AND NEW.book_id IS NOT NULL THEN
        WITH hit AS (
            UPDATE price_alert
            SET is_active = false, triggered_at = now()
            WHERE is_active AND book_id = NEW.book_id AND max_price >= NEW.price AND student_id <> NEW.seller_id
            RETURNING student_id
        )
        INSERT INTO notification (student_id, type, title, body, related_listing_id)
        SELECT hit.student_id, 'PRICE_ALERT', 'Price alert',
               '"' || NEW.title || '" is listed for ' || NEW.price || '.', NEW.listing_id
        FROM hit;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_listing_price_alerts
AFTER INSERT OR UPDATE OF price, status ON listing
FOR EACH ROW EXECUTE FUNCTION listing_price_alerts();

-- ---------------------------------------------------------------------------
-- auction: only AUCTION listings, initialise price fields
-- ---------------------------------------------------------------------------
CREATE FUNCTION auction_before_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT listing_type FROM listing WHERE listing_id = NEW.listing_id) <> 'AUCTION' THEN
        RAISE EXCEPTION 'An auction can only be created for a listing of type AUCTION' USING ERRCODE = 'check_violation';
    END IF;
    NEW.current_price := NEW.starting_price;
    NEW.original_end_time := NEW.end_time;
    NEW.highest_bidder_id := NULL;
    NEW.winner_id := NULL;
    NEW.extension_count := 0;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auction_before_insert
BEFORE INSERT ON auction
FOR EACH ROW EXECUTE FUNCTION auction_before_insert();

-- ---------------------------------------------------------------------------
-- bid: database-level bid validation. Invalid bids are rejected even when
-- inserted outside place_bid().
-- ---------------------------------------------------------------------------
CREATE FUNCTION validate_bid() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_auction auction%ROWTYPE;
    v_seller INTEGER;
    v_min NUMERIC;
BEGIN
    SELECT * INTO v_auction FROM auction WHERE auction_id = NEW.auction_id;
    SELECT seller_id INTO v_seller FROM listing WHERE listing_id = v_auction.listing_id;

    IF v_auction.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Auction is not open for bidding' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.placed_at < v_auction.start_time THEN
        RAISE EXCEPTION 'Auction has not started yet' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.placed_at >= v_auction.end_time THEN
        RAISE EXCEPTION 'Auction has already ended' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.bidder_id = v_seller THEN
        RAISE EXCEPTION 'Sellers cannot bid on their own auction' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT status FROM student WHERE student_id = NEW.bidder_id) <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Suspended students cannot bid' USING ERRCODE = 'check_violation';
    END IF;

    IF v_auction.highest_bidder_id IS NULL THEN
        v_min := v_auction.starting_price;
    ELSE
        v_min := v_auction.current_price + v_auction.min_increment;
    END IF;
    IF NEW.amount < v_min THEN
        RAISE EXCEPTION 'Bid must be at least %', v_min USING ERRCODE = 'check_violation';
    END IF;

    NEW.seconds_before_end := ROUND(EXTRACT(EPOCH FROM (v_auction.end_time - NEW.placed_at))::NUMERIC, 2);
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_bid_validate
BEFORE INSERT ON bid
FOR EACH ROW EXECUTE FUNCTION validate_bid();

-- ---------------------------------------------------------------------------
-- offer: only on ACTIVE fixed-price listings, not by the seller; notify the seller
-- ---------------------------------------------------------------------------
CREATE FUNCTION validate_offer() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_listing listing%ROWTYPE;
BEGIN
    SELECT * INTO v_listing FROM listing WHERE listing_id = NEW.listing_id;
    IF v_listing.listing_type <> 'FIXED_PRICE' OR v_listing.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Offers can only be made on active fixed-price listings' USING ERRCODE = 'check_violation';
    END IF;
    IF v_listing.seller_id = NEW.buyer_id THEN
        RAISE EXCEPTION 'You cannot make an offer on your own listing' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_offer_validate
BEFORE INSERT ON offer
FOR EACH ROW EXECUTE FUNCTION validate_offer();

CREATE FUNCTION offer_notify_seller() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO notification (student_id, type, title, body, related_listing_id)
    SELECT l.seller_id, 'NEW_OFFER', 'New offer', 'You received an offer of ' || NEW.amount || ' for "' || l.title || '".', l.listing_id
    FROM listing l WHERE l.listing_id = NEW.listing_id;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_offer_notify
AFTER INSERT ON offer
FOR EACH ROW EXECUTE FUNCTION offer_notify_seller();

-- ---------------------------------------------------------------------------
-- swap_preference: the student must own the offered listing
-- ---------------------------------------------------------------------------
CREATE FUNCTION validate_swap_preference() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM listing WHERE listing_id = NEW.offered_listing_id AND seller_id = NEW.student_id) THEN
        RAISE EXCEPTION 'You can only offer a listing that you own' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_swap_preference_validate
BEFORE INSERT OR UPDATE ON swap_preference
FOR EACH ROW EXECUTE FUNCTION validate_swap_preference();

-- ---------------------------------------------------------------------------
-- transactions: STATE MACHINE
--   BEFORE UPDATE: reject invalid transitions (see is_valid_transition)
--   AFTER INSERT/UPDATE: write transaction_state_history, update the listing, notify both parties
-- The actor comes from the transaction-local settings app.actor_type / app.actor_id
-- (set by transition_transaction); without them the actor is SYSTEM.
-- ---------------------------------------------------------------------------
CREATE FUNCTION tx_validate_transition() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.state IS DISTINCT FROM OLD.state THEN
        IF NOT is_valid_transition(OLD.state, NEW.state) THEN
            RAISE EXCEPTION 'Invalid transaction state change: % -> %', OLD.state, NEW.state USING ERRCODE = 'check_violation';
        END IF;
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tx_validate_transition
BEFORE UPDATE OF state ON transactions
FOR EACH ROW EXECUTE FUNCTION tx_validate_transition();

CREATE FUNCTION tx_after_change() RETURNS TRIGGER
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
            PERFORM notify_next_waitlist(NEW.listing_id);       -- item is back: tell the first waiting student
        END IF;
    END IF;

    PERFORM tf_notify(NEW.buyer_id, 'TRANSACTION_UPDATE', 'Transaction updated',
                      '"' || v_listing.title || '" is now ' || NEW.state || '.', NEW.listing_id);
    PERFORM tf_notify(NEW.seller_id, 'TRANSACTION_UPDATE', 'Transaction updated',
                      '"' || v_listing.title || '" is now ' || NEW.state || '.', NEW.listing_id);
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_tx_after_change
AFTER INSERT OR UPDATE OF state ON transactions
FOR EACH ROW EXECUTE FUNCTION tx_after_change();

-- ---------------------------------------------------------------------------
-- rating: only the buyer and the seller of a CONFIRMED/RELEASED transaction may rate each other
-- ---------------------------------------------------------------------------
CREATE FUNCTION validate_rating() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_tx transactions%ROWTYPE;
BEGIN
    SELECT * INTO v_tx FROM transactions WHERE transaction_id = NEW.transaction_id;
    IF v_tx.state NOT IN ('CONFIRMED', 'RELEASED') THEN
        RAISE EXCEPTION 'Only completed transactions can be rated' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((NEW.rater_id = v_tx.buyer_id AND NEW.ratee_id = v_tx.seller_id)
         OR (NEW.rater_id = v_tx.seller_id AND NEW.ratee_id = v_tx.buyer_id)) THEN
        RAISE EXCEPTION 'Only the buyer and seller of the transaction can rate each other' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rating_validate
BEFORE INSERT ON rating
FOR EACH ROW EXECUTE FUNCTION validate_rating();

-- ---------------------------------------------------------------------------
-- message: sender must be part of the conversation; notify the other person
-- ---------------------------------------------------------------------------
CREATE FUNCTION message_after_insert() RETURNS TRIGGER
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
    PERFORM tf_notify(v_recipient, 'MESSAGE', 'New message', 'You have a new message.', v_conv.listing_id);
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_message_after_insert
AFTER INSERT ON message
FOR EACH ROW EXECUTE FUNCTION message_after_insert();

-- ---------------------------------------------------------------------------
-- report: fill the reported student from the listing, forbid self-reports,
-- and tell the reporter when the report is handled
-- ---------------------------------------------------------------------------
CREATE FUNCTION report_before_insert() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.reported_student_id IS NULL AND NEW.reported_listing_id IS NOT NULL THEN
        SELECT seller_id INTO NEW.reported_student_id FROM listing WHERE listing_id = NEW.reported_listing_id;
    END IF;
    IF NEW.reported_student_id = NEW.reporter_id THEN
        RAISE EXCEPTION 'You cannot report yourself' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_report_before_insert
BEFORE INSERT ON report
FOR EACH ROW EXECUTE FUNCTION report_before_insert();

CREATE FUNCTION report_notify_reporter() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'OPEN' AND NEW.status <> 'OPEN' THEN
        PERFORM tf_notify(NEW.reporter_id, 'REPORT_UPDATE', 'Your report was reviewed',
                          'An administrator handled your report: ' || NEW.status || '.', NEW.reported_listing_id);
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER trg_report_notify_reporter
AFTER UPDATE OF status ON report
FOR EACH ROW EXECUTE FUNCTION report_notify_reporter();
