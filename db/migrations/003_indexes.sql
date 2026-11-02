-- 003_indexes.sql
-- Indexes. PRIMARY KEY and UNIQUE constraints already create their own indexes.
-- The HNSW vector index is created in 007_pgvector.sql.

-- Full-text search: GIN index on the tsvector column of listing
CREATE INDEX idx_listing_search_vector ON listing USING GIN (search_vector);

-- Marketplace browsing and filtering
CREATE INDEX idx_listing_status_type ON listing (status, listing_type);
CREATE INDEX idx_listing_campus_status ON listing (campus_id, status);
CREATE INDEX idx_listing_book ON listing (book_id);
CREATE INDEX idx_listing_seller ON listing (seller_id);
CREATE INDEX idx_listing_price ON listing (price);
CREATE INDEX idx_book_course ON book (course_id);
CREATE INDEX idx_book_subject ON book (subject);

-- Auctions and bids
CREATE INDEX idx_auction_status_end ON auction (status, end_time);
CREATE INDEX idx_bid_auction_time ON bid (auction_id, placed_at);
CREATE INDEX idx_bid_bidder ON bid (bidder_id);
-- Two valid bids of the same amount on one auction can never exist (extra race-condition safety net)
CREATE UNIQUE INDEX uq_bid_auction_amount_valid ON bid (auction_id, amount) WHERE status = 'VALID';

-- Offers, wishlist, swaps
CREATE INDEX idx_offer_listing ON offer (listing_id, status);
CREATE INDEX idx_wishlist_listing ON wishlist (listing_id);
CREATE INDEX idx_swap_pref_book ON swap_preference (wanted_book_id);
CREATE INDEX idx_swap_request_cycle ON swap_request (cycle_id);
CREATE INDEX idx_swap_request_listings ON swap_request (offered_listing_id, requested_listing_id);

-- Transactions: at most one unfinished transaction per listing
CREATE UNIQUE INDEX uq_tx_one_active_per_listing ON transactions (listing_id) WHERE state NOT IN ('RELEASED', 'CANCELLED');
CREATE INDEX idx_tx_buyer ON transactions (buyer_id);
CREATE INDEX idx_tx_seller ON transactions (seller_id);
CREATE INDEX idx_tx_state ON transactions (state);
CREATE INDEX idx_tx_history_tx ON transaction_state_history (transaction_id, changed_at);

-- Waitlist (FIFO lookup)
CREATE INDEX idx_waitlist_queue ON waitlist (listing_id, status, joined_at);

-- Ratings, chat, notifications, reports, alerts, activity
CREATE INDEX idx_rating_ratee ON rating (ratee_id);
CREATE INDEX idx_message_conversation ON message (conversation_id, sent_at);
CREATE INDEX idx_conversation_seller ON conversation (seller_id);
CREATE INDEX idx_notification_unread ON notification (student_id, is_read, created_at DESC);
CREATE INDEX idx_report_status ON report (status, created_at);
CREATE INDEX idx_report_student ON report (reported_student_id);
CREATE INDEX idx_price_alert_book ON price_alert (book_id) WHERE is_active;
CREATE INDEX idx_search_book_time ON search_activity (book_id, searched_at);
CREATE INDEX idx_search_course_time ON search_activity (course_id, searched_at);
CREATE INDEX idx_search_student ON search_activity (student_id, searched_at);

-- Student verification, photos, recently viewed, course search
CREATE INDEX idx_auth_token_student ON auth_token (student_id, purpose);
CREATE INDEX idx_image_owner ON image (owner_id, purpose);
CREATE UNIQUE INDEX uq_image_one_profile_photo ON image (owner_id) WHERE purpose = 'PROFILE';
CREATE INDEX idx_listing_image_listing ON listing_image (listing_id, position);
CREATE INDEX idx_recently_viewed_student ON recently_viewed (student_id, viewed_at DESC);
CREATE INDEX idx_course_dept_semester ON course (department_id, semester);
CREATE INDEX idx_student_department ON student (department_id);
