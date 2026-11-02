-- 002_constraints.sql
-- CHECK constraints added with ALTER TABLE ... ADD CONSTRAINT (demonstrates ALTER).
-- One constraint per line: scripts/gen_docs.py lists them in the data dictionary.

-- student
ALTER TABLE student ADD CONSTRAINT ck_student_email CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND email = lower(email));
ALTER TABLE student ADD CONSTRAINT ck_student_srn CHECK (srn ~ '^[A-Z0-9]{8,20}$');
ALTER TABLE student ADD CONSTRAINT ck_student_semester CHECK (semester BETWEEN 1 AND 8);
ALTER TABLE student ADD CONSTRAINT ck_student_program CHECK (program = 'B.Tech');
ALTER TABLE student ADD CONSTRAINT ck_student_contact_pref CHECK (contact_preference IN ('IN_APP', 'EMAIL', 'PHONE'));
ALTER TABLE student ADD CONSTRAINT ck_student_phone CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{10,13}$');
ALTER TABLE student ADD CONSTRAINT ck_student_phone_needed CHECK (contact_preference <> 'PHONE' OR phone IS NOT NULL);
ALTER TABLE student ADD CONSTRAINT ck_student_status CHECK (status IN ('ACTIVE', 'SUSPENDED'));
ALTER TABLE student ADD CONSTRAINT ck_student_warnings CHECK (warning_count >= 0);
ALTER TABLE student ADD CONSTRAINT ck_student_password_hash CHECK (char_length(password_hash) >= 20);

-- course
ALTER TABLE course ADD CONSTRAINT ck_course_semester CHECK (semester BETWEEN 1 AND 8);

-- college_email_domain
ALTER TABLE college_email_domain ADD CONSTRAINT ck_domain_format CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$');

-- auth_token
ALTER TABLE auth_token ADD CONSTRAINT ck_auth_token_purpose CHECK (purpose IN ('VERIFY_EMAIL', 'RESET_PASSWORD'));

-- image / listing_image
ALTER TABLE image ADD CONSTRAINT ck_image_purpose CHECK (purpose IN ('PROFILE', 'LISTING'));
ALTER TABLE image ADD CONSTRAINT ck_image_type CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp'));
ALTER TABLE image ADD CONSTRAINT ck_image_size CHECK (size_bytes BETWEEN 1 AND 2097152);
ALTER TABLE listing_image ADD CONSTRAINT ck_listing_image_position CHECK (position BETWEEN 0 AND 4);

-- admin
ALTER TABLE admin ADD CONSTRAINT ck_admin_email CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND email = lower(email));
ALTER TABLE admin ADD CONSTRAINT ck_admin_password_hash CHECK (char_length(password_hash) >= 20);

-- book
ALTER TABLE book ADD CONSTRAINT ck_book_edition CHECK (edition >= 1);
ALTER TABLE book ADD CONSTRAINT ck_book_isbn CHECK (isbn IS NULL OR isbn ~ '^([0-9]{9}[0-9X]|[0-9]{13})$');

-- listing
ALTER TABLE listing ADD CONSTRAINT ck_listing_title CHECK (char_length(btrim(title)) > 0);
ALTER TABLE listing ADD CONSTRAINT ck_listing_category CHECK (category IN ('TEXTBOOK', 'GOODS'));
ALTER TABLE listing ADD CONSTRAINT ck_listing_condition CHECK (item_condition IN ('NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR'));
ALTER TABLE listing ADD CONSTRAINT ck_listing_type CHECK (listing_type IN ('FIXED_PRICE', 'AUCTION'));
ALTER TABLE listing ADD CONSTRAINT ck_listing_price CHECK (price > 0 AND price <= 100000);
ALTER TABLE listing ADD CONSTRAINT ck_listing_status CHECK (status IN ('ACTIVE', 'RESERVED', 'SOLD', 'SWAPPED', 'REMOVED'));
ALTER TABLE listing ADD CONSTRAINT ck_listing_textbook_has_book CHECK (category <> 'TEXTBOOK' OR book_id IS NOT NULL);
ALTER TABLE listing ADD CONSTRAINT ck_listing_auction_no_swap CHECK (listing_type = 'FIXED_PRICE' OR open_to_swap = false);

-- auction
ALTER TABLE auction ADD CONSTRAINT ck_auction_starting_price CHECK (starting_price > 0);
ALTER TABLE auction ADD CONSTRAINT ck_auction_increment CHECK (min_increment > 0);
ALTER TABLE auction ADD CONSTRAINT ck_auction_dates CHECK (end_time > start_time);
ALTER TABLE auction ADD CONSTRAINT ck_auction_original_end CHECK (original_end_time <= end_time);
ALTER TABLE auction ADD CONSTRAINT ck_auction_current_price CHECK (current_price >= starting_price);
ALTER TABLE auction ADD CONSTRAINT ck_auction_status CHECK (status IN ('ACTIVE', 'CLOSED', 'CANCELLED'));
ALTER TABLE auction ADD CONSTRAINT ck_auction_extensions CHECK (extension_count >= 0);
ALTER TABLE auction ADD CONSTRAINT ck_auction_winner_only_when_closed CHECK (winner_id IS NULL OR status = 'CLOSED');

-- bid
ALTER TABLE bid ADD CONSTRAINT ck_bid_amount CHECK (amount > 0);
ALTER TABLE bid ADD CONSTRAINT ck_bid_status CHECK (status IN ('VALID', 'CANCELLED'));

-- offer
ALTER TABLE offer ADD CONSTRAINT ck_offer_amount CHECK (amount > 0);
ALTER TABLE offer ADD CONSTRAINT ck_offer_status CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'));

-- swap_request
ALTER TABLE swap_request ADD CONSTRAINT ck_swap_status CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'));
ALTER TABLE swap_request ADD CONSTRAINT ck_swap_different_listings CHECK (offered_listing_id <> requested_listing_id);

-- transactions
ALTER TABLE transactions ADD CONSTRAINT ck_tx_amount CHECK (amount >= 0);
ALTER TABLE transactions ADD CONSTRAINT ck_tx_parties CHECK (buyer_id <> seller_id);
ALTER TABLE transactions ADD CONSTRAINT ck_tx_type CHECK (transaction_type IN ('PURCHASE', 'AUCTION_WIN', 'SWAP'));
ALTER TABLE transactions ADD CONSTRAINT ck_tx_state CHECK (state IN ('PENDING', 'PAYMENT_HELD', 'HANDED_OFF', 'CONFIRMED', 'RELEASED', 'CANCELLED'));
ALTER TABLE transactions ADD CONSTRAINT ck_tx_swap_link CHECK ((transaction_type = 'SWAP') = (swap_request_id IS NOT NULL));

-- transaction_state_history
ALTER TABLE transaction_state_history ADD CONSTRAINT ck_history_new_state CHECK (new_state IN ('PENDING', 'PAYMENT_HELD', 'HANDED_OFF', 'CONFIRMED', 'RELEASED', 'CANCELLED'));
ALTER TABLE transaction_state_history ADD CONSTRAINT ck_history_prev_state CHECK (previous_state IS NULL OR previous_state IN ('PENDING', 'PAYMENT_HELD', 'HANDED_OFF', 'CONFIRMED', 'RELEASED', 'CANCELLED'));
ALTER TABLE transaction_state_history ADD CONSTRAINT ck_history_actor CHECK (changed_by_type IN ('STUDENT', 'ADMIN', 'SYSTEM'));

-- waitlist
ALTER TABLE waitlist ADD CONSTRAINT ck_waitlist_status CHECK (status IN ('WAITING', 'NOTIFIED', 'CLAIMED', 'EXPIRED', 'CANCELLED'));
ALTER TABLE waitlist ADD CONSTRAINT ck_waitlist_claim_window CHECK (status <> 'NOTIFIED' OR claim_expires_at IS NOT NULL);

-- rating / review
ALTER TABLE rating ADD CONSTRAINT ck_rating_score CHECK (score BETWEEN 1 AND 5);
ALTER TABLE rating ADD CONSTRAINT ck_rating_not_self CHECK (rater_id <> ratee_id);
ALTER TABLE review ADD CONSTRAINT ck_review_body CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000);

-- chat
ALTER TABLE conversation ADD CONSTRAINT ck_conversation_parties CHECK (buyer_id <> seller_id);
ALTER TABLE message ADD CONSTRAINT ck_message_body CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000);

-- notification
ALTER TABLE notification ADD CONSTRAINT ck_notification_type CHECK (type IN ('OUTBID', 'AUCTION_WON', 'AUCTION_SOLD', 'AUCTION_ENDING', 'NEW_OFFER', 'OFFER_ACCEPTED', 'SWAP_MATCH', 'WAITLIST_AVAILABLE', 'PRICE_ALERT', 'PURCHASE', 'TRANSACTION_UPDATE', 'MESSAGE', 'REPORT_UPDATE', 'LISTING_SOLD'));

-- report
ALTER TABLE report ADD CONSTRAINT ck_report_reason CHECK (reason IN ('FAKE_LISTING', 'WRONG_DESCRIPTION', 'SCAM', 'SPAM', 'SUSPICIOUS_BEHAVIOR'));
ALTER TABLE report ADD CONSTRAINT ck_report_status CHECK (status IN ('OPEN', 'DISMISSED', 'WARNED', 'LISTING_REMOVED', 'USER_SUSPENDED'));
ALTER TABLE report ADD CONSTRAINT ck_report_has_target CHECK (reported_listing_id IS NOT NULL OR reported_student_id IS NOT NULL);
ALTER TABLE report ADD CONSTRAINT ck_report_resolved CHECK ((status = 'OPEN') = (resolved_at IS NULL));

-- price_alert
ALTER TABLE price_alert ADD CONSTRAINT ck_alert_price CHECK (max_price > 0);

-- search_activity
ALTER TABLE search_activity ADD CONSTRAINT ck_search_type CHECK (search_type IN ('FULLTEXT', 'SEMANTIC', 'VIEW'));
