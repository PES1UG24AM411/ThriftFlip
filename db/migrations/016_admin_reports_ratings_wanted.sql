-- 016_admin_reports_ratings_wanted.sql
-- A new, additive migration (older files are NOT edited; existing data is kept).
--
--   1. Swaps:    "wanted books" a seller lists when a listing is open to swap (catalogue book or custom title).
--   2. Ratings:  the reputation SCORE is removed. v_student_reputation is replaced by v_student_ratings
--                (average rating, number of ratings and finished-deal counts); v_listing_details no longer has
--                seller_reputation and shows the seller's average rating instead.
--                Reviews can be hidden by an admin (the star rating itself stays).
--   3. Reports:  workflow PENDING -> UNDER_REVIEW -> RESOLVED or DISMISSED. Old statuses are converted:
--                OPEN -> PENDING, WARNED / LISTING_REMOVED / USER_SUSPENDED -> RESOLVED (nothing else changes).
--   4. Admin:    admin_action (who did what and why), admin_message (official messages and the student's replies)
--                and the functions that do the moderation. Nothing happens automatically because of a report.

-- ---------------------------------------------------------------------------
-- 1. Wanted books
-- ---------------------------------------------------------------------------
CREATE TABLE listing_wanted_book (
    wanted_id SERIAL PRIMARY KEY, -- surrogate key
    listing_id INTEGER NOT NULL REFERENCES listing(listing_id) ON DELETE CASCADE, -- listing that is open to swap
    book_id INTEGER REFERENCES book(book_id), -- wanted book from the catalogue ...
    custom_title TEXT, -- ... or a title typed by the seller (exactly one of the two)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_wanted_one CHECK ((book_id IS NOT NULL) <> (custom_title IS NOT NULL)),
    CONSTRAINT ck_wanted_title CHECK (custom_title IS NULL OR char_length(btrim(custom_title)) BETWEEN 2 AND 150)
);
CREATE UNIQUE INDEX uq_wanted_book ON listing_wanted_book (listing_id, book_id) WHERE book_id IS NOT NULL;
CREATE UNIQUE INDEX uq_wanted_custom ON listing_wanted_book (listing_id, lower(btrim(custom_title))) WHERE custom_title IS NOT NULL;
CREATE INDEX idx_wanted_listing ON listing_wanted_book (listing_id);

-- at most 5 wanted books per listing
CREATE FUNCTION wanted_book_limit() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF (SELECT COUNT(*) FROM listing_wanted_book WHERE listing_id = NEW.listing_id) >= 5 THEN
        RAISE EXCEPTION 'A listing can have at most 5 wanted books' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_wanted_book_limit BEFORE INSERT ON listing_wanted_book FOR EACH ROW EXECUTE FUNCTION wanted_book_limit();

-- ---------------------------------------------------------------------------
-- 2. Ratings and reviews (reputation score removed)
-- ---------------------------------------------------------------------------
DROP VIEW v_listing_details;
DROP VIEW v_student_reputation;

CREATE VIEW v_student_ratings AS
WITH released AS (
    SELECT t.transaction_id, t.buyer_id, t.seller_id,
           COALESCE('C' || sr.cycle_id::text, 'P' || t.swap_proposal_id::text, 'T' || t.transaction_id::text) AS deal_key,
           (t.transaction_type = 'SWAP') AS is_swap
    FROM transactions t
    LEFT JOIN swap_request sr ON sr.swap_request_id = t.swap_request_id
    WHERE t.state = 'RELEASED'
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
    ROUND(r.avg_rating, 2) AS avg_rating, -- NULL when the student has no rating yet ("Not rated yet")
    COALESCE(d.completed_sales, 0)::INTEGER AS completed_sales,
    COALESCE(d.completed_swaps, 0)::INTEGER AS completed_swaps,
    (COALESCE(d.completed_sales, 0) + COALESCE(d.completed_swaps, 0))::INTEGER AS completed_transactions
FROM student s
LEFT JOIN ratings r ON r.ratee_id = s.student_id
LEFT JOIN deal_counts d ON d.student_id = s.student_id;

CREATE VIEW v_listing_details AS
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
    (SELECT string_agg(COALESCE(wb.title, w.custom_title), ' | ' ORDER BY w.wanted_id)
       FROM listing_wanted_book w LEFT JOIN book wb ON wb.book_id = w.book_id
      WHERE w.listing_id = l.listing_id) AS wanted_books
FROM listing l
JOIN student s ON s.student_id = l.seller_id
JOIN campus c ON c.campus_id = l.campus_id
JOIN v_student_ratings rt ON rt.student_id = l.seller_id
LEFT JOIN book b ON b.book_id = l.book_id
LEFT JOIN course co ON co.course_id = b.course_id
LEFT JOIN department dep ON dep.department_id = co.department_id
LEFT JOIN auction a ON a.listing_id = l.listing_id;

-- an admin can hide an inappropriate review text; the star rating itself stays
ALTER TABLE review ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE review ADD COLUMN hidden_reason TEXT;
ALTER TABLE review ADD COLUMN hidden_at TIMESTAMPTZ;
ALTER TABLE review ADD CONSTRAINT ck_review_hidden CHECK (is_hidden = (hidden_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 3. Report workflow
-- ---------------------------------------------------------------------------
ALTER TABLE report DISABLE TRIGGER trg_report_notify_reporter; -- the conversion below must not notify anybody
ALTER TABLE report DROP CONSTRAINT ck_report_status;
ALTER TABLE report DROP CONSTRAINT ck_report_resolved;
ALTER TABLE report ALTER COLUMN status SET DEFAULT 'PENDING';
UPDATE report SET status = CASE status WHEN 'OPEN' THEN 'PENDING' WHEN 'DISMISSED' THEN 'DISMISSED' ELSE 'RESOLVED' END;
ALTER TABLE report ADD CONSTRAINT ck_report_status CHECK (status IN ('PENDING', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'));
ALTER TABLE report ADD CONSTRAINT ck_report_resolved CHECK ((status IN ('RESOLVED', 'DISMISSED')) = (resolved_at IS NOT NULL));
ALTER TABLE report ENABLE TRIGGER trg_report_notify_reporter;

CREATE OR REPLACE FUNCTION report_notify_reporter() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        PERFORM tf_notify(NEW.reporter_id, 'REPORT_UPDATE',
            CASE NEW.status WHEN 'UNDER_REVIEW' THEN 'Your report is being reviewed'
                            WHEN 'RESOLVED' THEN 'Your report was resolved'
                            ELSE 'Your report was closed' END,
            CASE NEW.status WHEN 'UNDER_REVIEW' THEN 'An administrator started to look at your report.'
                            WHEN 'RESOLVED' THEN 'An administrator reviewed your report and took the steps needed. Thank you.'
                            ELSE 'An administrator reviewed your report and found no reason to act.' END,
            NEW.reported_listing_id);
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Admin actions and official messages
-- ---------------------------------------------------------------------------
ALTER TABLE notification DROP CONSTRAINT ck_notification_type;
ALTER TABLE notification ADD CONSTRAINT ck_notification_type CHECK (type IN (
    'OUTBID', 'AUCTION_WON', 'AUCTION_SOLD', 'AUCTION_ENDING', 'NEW_OFFER', 'OFFER_ACCEPTED', 'SWAP_MATCH',
    'WAITLIST_AVAILABLE', 'PRICE_ALERT', 'PURCHASE', 'TRANSACTION_UPDATE', 'MESSAGE', 'REPORT_UPDATE', 'LISTING_SOLD',
    'SWAP_PROPOSAL', 'SWAP_UPDATE', 'ADMIN_MESSAGE'));

CREATE TABLE admin_action (
    action_id SERIAL PRIMARY KEY, -- surrogate key
    admin_id INTEGER NOT NULL REFERENCES admin(admin_id), -- administrator who acted
    action TEXT NOT NULL, -- what was done
    report_id INTEGER REFERENCES report(report_id) ON DELETE SET NULL, -- report it belongs to (if any)
    student_id INTEGER REFERENCES student(student_id) ON DELETE SET NULL, -- student concerned (if any)
    listing_id INTEGER REFERENCES listing(listing_id) ON DELETE SET NULL, -- listing concerned (if any)
    review_id INTEGER REFERENCES review(review_id) ON DELETE SET NULL, -- review concerned (if any)
    reason TEXT NOT NULL, -- why (required)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_admin_action_type CHECK (action IN (
        'REPORT_UNDER_REVIEW', 'REPORT_RESOLVED', 'REPORT_DISMISSED', 'WARN_USER', 'SUSPEND_USER', 'REACTIVATE_USER',
        'REMOVE_LISTING', 'RESTORE_LISTING', 'HIDE_REVIEW', 'RESTORE_REVIEW', 'SEND_MESSAGE')),
    CONSTRAINT ck_admin_action_reason CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000)
);
CREATE INDEX idx_admin_action_report ON admin_action (report_id);
CREATE INDEX idx_admin_action_created ON admin_action (created_at DESC);

CREATE TABLE admin_message (
    admin_message_id SERIAL PRIMARY KEY, -- surrogate key
    student_id INTEGER NOT NULL REFERENCES student(student_id) ON DELETE CASCADE, -- the student this conversation is with
    sender_type TEXT NOT NULL, -- ADMIN or STUDENT (the student's reply)
    admin_id INTEGER REFERENCES admin(admin_id), -- sending admin (NULL for a student's reply)
    report_id INTEGER REFERENCES report(report_id) ON DELETE SET NULL, -- report it is about (optional)
    listing_id INTEGER REFERENCES listing(listing_id) ON DELETE SET NULL, -- listing it is about (optional)
    kind TEXT NOT NULL DEFAULT 'MESSAGE', -- MESSAGE, CLARIFICATION, WARNING or NOTICE
    body TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT false, -- read by the receiver (student for ADMIN messages, admins for replies)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_admin_message_sender CHECK (sender_type IN ('ADMIN', 'STUDENT') AND ((sender_type = 'ADMIN') = (admin_id IS NOT NULL))),
    CONSTRAINT ck_admin_message_kind CHECK (kind IN ('MESSAGE', 'CLARIFICATION', 'WARNING', 'NOTICE')),
    CONSTRAINT ck_admin_message_body CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)
);
CREATE INDEX idx_admin_message_student ON admin_message (student_id, created_at);
CREATE INDEX idx_admin_message_report ON admin_message (report_id);

-- admin_set_report_status: PENDING -> UNDER_REVIEW -> RESOLVED or DISMISSED. A reason is required.
CREATE FUNCTION admin_set_report_status(p_admin_id INTEGER, p_report_id INTEGER, p_status TEXT, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_report report%ROWTYPE;
BEGIN
    IF p_status NOT IN ('UNDER_REVIEW', 'RESOLVED', 'DISMISSED') THEN
        RAISE EXCEPTION 'Unknown report status' USING ERRCODE = 'check_violation';
    END IF;
    IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 THEN
        RAISE EXCEPTION 'Please write the reason (at least 3 characters)' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO v_report FROM report WHERE report_id = p_report_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Report not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF p_status = 'UNDER_REVIEW' AND v_report.status <> 'PENDING' THEN
        RAISE EXCEPTION 'Only a pending report can be moved to review (this one is %)', lower(v_report.status) USING ERRCODE = 'check_violation';
    END IF;
    IF p_status IN ('RESOLVED', 'DISMISSED') AND v_report.status <> 'UNDER_REVIEW' THEN
        RAISE EXCEPTION 'Start the review first: a report must be under review before it is resolved or dismissed (this one is %)', lower(v_report.status) USING ERRCODE = 'check_violation';
    END IF;
    UPDATE report
       SET status = p_status,
           resolved_by = CASE WHEN p_status = 'UNDER_REVIEW' THEN NULL ELSE p_admin_id END,
           resolved_at = CASE WHEN p_status = 'UNDER_REVIEW' THEN NULL ELSE now() END
     WHERE report_id = p_report_id;
    INSERT INTO admin_action (admin_id, action, report_id, student_id, listing_id, reason)
    VALUES (p_admin_id, 'REPORT_' || p_status, p_report_id, v_report.reported_student_id, v_report.reported_listing_id, btrim(p_reason));
END;
$$;

-- admin_take_action: one explicit moderation step. Nothing is done unless an admin calls this, and a step that
-- belongs to a report is only allowed while that report is UNDER_REVIEW. The affected student is told the reason.
CREATE FUNCTION admin_take_action(
    p_admin_id INTEGER, p_action TEXT, p_reason TEXT,
    p_student_id INTEGER DEFAULT NULL, p_listing_id INTEGER DEFAULT NULL, p_review_id INTEGER DEFAULT NULL,
    p_report_id INTEGER DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
    v_reason TEXT := btrim(COALESCE(p_reason, ''));
    v_report report%ROWTYPE;
    v_listing listing%ROWTYPE;
    v_student student%ROWTYPE;
    v_rater INTEGER;
    v_target INTEGER; -- student who receives the notice
    v_title TEXT;
    v_kind TEXT := 'NOTICE';
BEGIN
    IF p_action NOT IN ('WARN_USER', 'SUSPEND_USER', 'REACTIVATE_USER', 'REMOVE_LISTING', 'RESTORE_LISTING', 'HIDE_REVIEW', 'RESTORE_REVIEW') THEN
        RAISE EXCEPTION 'Unknown moderation action' USING ERRCODE = 'check_violation';
    END IF;
    IF char_length(v_reason) < 3 THEN
        RAISE EXCEPTION 'Please write the reason (at least 3 characters)' USING ERRCODE = 'check_violation';
    END IF;
    IF p_report_id IS NOT NULL THEN
        SELECT * INTO v_report FROM report WHERE report_id = p_report_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Report not found' USING ERRCODE = 'no_data_found'; END IF;
        IF v_report.status <> 'UNDER_REVIEW' THEN
            RAISE EXCEPTION 'Start the review of this report before taking action (it is %)', lower(v_report.status) USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    IF p_action IN ('WARN_USER', 'SUSPEND_USER', 'REACTIVATE_USER') THEN
        SELECT * INTO v_student FROM student WHERE student_id = p_student_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Student not found' USING ERRCODE = 'no_data_found'; END IF;
        v_target := v_student.student_id;
        IF p_action = 'WARN_USER' THEN
            UPDATE student SET warning_count = warning_count + 1 WHERE student_id = v_target;
            v_title := 'Warning from the administrators'; v_kind := 'WARNING';
        ELSIF p_action = 'SUSPEND_USER' THEN
            IF v_student.status = 'SUSPENDED' THEN RAISE EXCEPTION 'This account is already suspended' USING ERRCODE = 'check_violation'; END IF;
            UPDATE student SET status = 'SUSPENDED' WHERE student_id = v_target;
            UPDATE listing SET status = 'REMOVED' WHERE seller_id = v_target AND status = 'ACTIVE';
            v_title := 'Your account was suspended';
        ELSE
            IF v_student.status = 'ACTIVE' THEN RAISE EXCEPTION 'This account is already active' USING ERRCODE = 'check_violation'; END IF;
            UPDATE student SET status = 'ACTIVE' WHERE student_id = v_target;
            v_title := 'Your account was reactivated';
        END IF;
    ELSIF p_action IN ('REMOVE_LISTING', 'RESTORE_LISTING') THEN
        SELECT * INTO v_listing FROM listing WHERE listing_id = p_listing_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found' USING ERRCODE = 'no_data_found'; END IF;
        v_target := v_listing.seller_id;
        IF p_action = 'REMOVE_LISTING' THEN
            IF v_listing.status <> 'ACTIVE' THEN
                RAISE EXCEPTION 'Only an active listing can be removed (this one is %)', lower(v_listing.status) USING ERRCODE = 'check_violation';
            END IF;
            UPDATE listing SET status = 'REMOVED' WHERE listing_id = p_listing_id;
            v_title := 'A listing of yours was removed';
        ELSE
            IF v_listing.status <> 'REMOVED' THEN
                RAISE EXCEPTION 'Only a removed listing can be restored' USING ERRCODE = 'check_violation';
            END IF;
            IF v_listing.listing_type <> 'FIXED_PRICE' THEN
                RAISE EXCEPTION 'Auction listings cannot be restored' USING ERRCODE = 'check_violation';
            END IF;
            IF (SELECT status FROM student WHERE student_id = v_target) <> 'ACTIVE' THEN
                RAISE EXCEPTION 'Reactivate the seller first' USING ERRCODE = 'check_violation';
            END IF;
            UPDATE listing SET status = 'ACTIVE' WHERE listing_id = p_listing_id;
            v_title := 'A listing of yours was restored';
        END IF;
    ELSE
        SELECT r.rater_id INTO v_rater FROM review rv JOIN rating r ON r.rating_id = rv.rating_id
         WHERE rv.review_id = p_review_id FOR UPDATE OF rv;
        IF NOT FOUND THEN RAISE EXCEPTION 'Review not found' USING ERRCODE = 'no_data_found'; END IF;
        v_target := v_rater;
        IF p_action = 'HIDE_REVIEW' THEN
            UPDATE review SET is_hidden = true, hidden_reason = v_reason, hidden_at = now() WHERE review_id = p_review_id AND NOT is_hidden;
            IF NOT FOUND THEN RAISE EXCEPTION 'This review is already hidden' USING ERRCODE = 'check_violation'; END IF;
            v_title := 'A review you wrote was hidden';
        ELSE
            UPDATE review SET is_hidden = false, hidden_reason = NULL, hidden_at = NULL WHERE review_id = p_review_id AND is_hidden;
            IF NOT FOUND THEN RAISE EXCEPTION 'This review is not hidden' USING ERRCODE = 'check_violation'; END IF;
            v_title := 'A review you wrote was restored';
        END IF;
    END IF;

    INSERT INTO admin_action (admin_id, action, report_id, student_id, listing_id, review_id, reason)
    VALUES (p_admin_id, p_action, p_report_id, v_target, p_listing_id, p_review_id, v_reason);

    -- the student sees the reason in the notification and in "Messages from admins", and can answer there
    IF p_action <> 'SUSPEND_USER' THEN
        INSERT INTO admin_message (student_id, sender_type, admin_id, report_id, listing_id, kind, body)
        VALUES (v_target, 'ADMIN', p_admin_id, p_report_id, p_listing_id, v_kind, v_title || '. Reason: ' || v_reason);
    END IF;
    PERFORM tf_notify(v_target, 'ADMIN_MESSAGE', v_title, 'Reason: ' || v_reason, p_listing_id);
END;
$$;

-- admin_send_message: an official message to a student (about a report, a listing or behaviour).
CREATE FUNCTION admin_send_message(
    p_admin_id INTEGER, p_student_id INTEGER, p_body TEXT, p_kind TEXT DEFAULT 'MESSAGE',
    p_report_id INTEGER DEFAULT NULL, p_listing_id INTEGER DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
    v_id INTEGER;
BEGIN
    IF p_kind NOT IN ('MESSAGE', 'CLARIFICATION') THEN
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
    INSERT INTO admin_action (admin_id, action, report_id, student_id, listing_id, reason)
    VALUES (p_admin_id, 'SEND_MESSAGE', p_report_id, p_student_id, p_listing_id, left(btrim(p_body), 1000));
    PERFORM tf_notify(p_student_id, 'ADMIN_MESSAGE',
        CASE p_kind WHEN 'CLARIFICATION' THEN 'The administrators need more information' ELSE 'Message from the administrators' END,
        left(btrim(p_body), 300), p_listing_id);
    RETURN v_id;
END;
$$;

-- the admin overview counts the new report statuses (column names stay the same; two columns are added at the end)
CREATE OR REPLACE VIEW v_admin_overview AS
SELECT
    (SELECT COUNT(*) FROM student) AS total_students,
    (SELECT COUNT(*) FROM student WHERE status = 'SUSPENDED') AS suspended_students,
    (SELECT COUNT(*) FROM listing WHERE status = 'ACTIVE') AS active_listings,
    (SELECT COUNT(*) FROM auction WHERE status = 'ACTIVE') AS active_auctions,
    (SELECT COUNT(*) FROM transactions WHERE state = 'RELEASED') AS completed_transactions,
    (SELECT COUNT(*) FROM transactions WHERE state NOT IN ('RELEASED', 'CANCELLED')) AS open_transactions,
    (SELECT COUNT(*) FROM report WHERE status IN ('PENDING', 'UNDER_REVIEW')) AS open_reports,
    (SELECT COUNT(*) FROM v_bid_risk WHERE risk_level <> 'NORMAL') AS flagged_bidder_pairs,
    (SELECT COUNT(*) FROM waitlist WHERE status IN ('WAITING', 'NOTIFIED')) AS waitlist_entries,
    (SELECT COUNT(*) FROM swap_request WHERE status IN ('PENDING', 'ACCEPTED')) AS open_swap_requests,
    (SELECT ROUND(AVG(amount), 2) FROM v_price_history) AS avg_sale_price,
    (SELECT COUNT(*) FROM report WHERE status = 'PENDING') AS pending_reports,
    (SELECT COUNT(*) FROM admin_message WHERE sender_type = 'STUDENT' AND NOT is_read) AS unread_replies;

-- ---------------------------------------------------------------------------
-- 5. The old one-click resolve_report() (OPEN -> WARNED / REMOVED / SUSPENDED) punished from a report alone.
--    It is replaced by admin_set_report_status() + admin_take_action() above.
-- ---------------------------------------------------------------------------
DROP FUNCTION resolve_report(INTEGER, INTEGER, TEXT);
