-- important_queries.sql
-- Queries for the DBMS viva. Run after db:migrate and db:seed, e.g.
--   docker exec -i thriftflip-db psql -U thriftflip -d thriftflip < db/queries/important_queries.sql
-- (UNTESTED against a live database in the authoring environment: run once and fix any typo.)

-- ===========================================================================
-- A. DDL: CREATE / ALTER / DROP on a scratch table (does not touch real data)
-- ===========================================================================
CREATE TABLE demo_tag (
    tag_id SERIAL PRIMARY KEY,
    label TEXT NOT NULL UNIQUE
);
ALTER TABLE demo_tag ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE demo_tag ADD CONSTRAINT ck_demo_tag_label CHECK (char_length(label) >= 2);

-- ===========================================================================
-- B. DML: INSERT / UPDATE / DELETE / SELECT
-- ===========================================================================
INSERT INTO demo_tag (label) VALUES ('calculus'), ('algorithms'), ('electronics');
UPDATE demo_tag SET label = 'discrete-maths' WHERE label = 'algorithms';
DELETE FROM demo_tag WHERE label = 'electronics';
SELECT tag_id, label FROM demo_tag ORDER BY label;

-- A violated CHECK is rejected by the database (expected ERROR):
-- INSERT INTO demo_tag (label) VALUES ('x');

DROP TABLE demo_tag;

-- ===========================================================================
-- C. JOIN + GROUP BY + HAVING + ORDER BY + aggregates
-- ===========================================================================

-- C1. Sellers with at least 2 active listings: count, average, min, max, total price.
--     Shows: JOIN, GROUP BY, HAVING, ORDER BY, COUNT/AVG/MIN/MAX/SUM.
SELECT s.name AS seller,
       COUNT(*)            AS active_listings,
       ROUND(AVG(l.price), 2) AS avg_price,
       MIN(l.price)        AS cheapest,
       MAX(l.price)        AS dearest,
       SUM(l.price)        AS total_value
FROM listing l
JOIN student s ON s.student_id = l.seller_id
WHERE l.status = 'ACTIVE'
GROUP BY s.student_id, s.name
HAVING COUNT(*) >= 2
ORDER BY active_listings DESC, total_value DESC;

-- C2. Highest bidder of every auction (join + subquery for the maximum bid).
SELECT l.title, st.name AS highest_bidder, b.amount, b.placed_at
FROM bid b
JOIN auction a  ON a.auction_id = b.auction_id
JOIN listing l  ON l.listing_id = a.listing_id
JOIN student st ON st.student_id = b.bidder_id
WHERE b.status = 'VALID'
  AND b.amount = (SELECT MAX(b2.amount) FROM bid b2 WHERE b2.auction_id = b.auction_id AND b2.status = 'VALID')
ORDER BY b.amount DESC;

-- C3. Auction statistics per campus: number of auctions, bids and extensions by anti-sniping.
SELECT c.name AS campus,
       COUNT(DISTINCT a.auction_id) AS auctions,
       COUNT(b.bid_id) AS bids,
       COALESCE(SUM(a.extension_count), 0) AS anti_snipe_extensions
FROM campus c
JOIN listing l ON l.campus_id = c.campus_id
JOIN auction a ON a.listing_id = l.listing_id
LEFT JOIN bid b ON b.auction_id = a.auction_id
GROUP BY c.campus_id, c.name
ORDER BY bids DESC;

-- C4. Transaction statistics by state and type.
SELECT transaction_type, state, COUNT(*) AS transactions, SUM(amount) AS total_amount
FROM transactions
GROUP BY transaction_type, state
ORDER BY transaction_type, state;

-- C5. Popular books: wishlist count per book (JOIN + GROUP BY + ORDER BY + LIMIT).
SELECT b.title, b.edition, COUNT(*) AS wishlisted
FROM wishlist w
JOIN listing l ON l.listing_id = w.listing_id
JOIN book b ON b.book_id = l.book_id
GROUP BY b.book_id, b.title, b.edition
ORDER BY wishlisted DESC
LIMIT 5;

-- ===========================================================================
-- D. Subqueries / nested queries / complex filtering
-- ===========================================================================

-- D1. Active listings priced below the average sale price of their own book (correlated subquery).
SELECT l.listing_id, l.title, l.price,
       (SELECT ROUND(AVG(h.amount), 2) FROM v_price_history h WHERE h.book_id = l.book_id) AS avg_sold_price
FROM listing l
WHERE l.status = 'ACTIVE'
  AND l.price < (SELECT AVG(h.amount) FROM v_price_history h WHERE h.book_id = l.book_id);

-- D2. Students who never placed a bid and never bought anything (NOT EXISTS).
SELECT s.student_id, s.name
FROM student s
WHERE NOT EXISTS (SELECT 1 FROM bid b WHERE b.bidder_id = s.student_id)
  AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.buyer_id = s.student_id);

-- D3. Complex filter: affordable, good-condition textbooks for a course, on one campus, newest first.
SELECT l.listing_id, l.title, l.price, l.item_condition
FROM listing l
JOIN book b ON b.book_id = l.book_id
JOIN course c ON c.course_id = b.course_id
WHERE l.status = 'ACTIVE'
  AND l.item_condition IN ('NEW', 'LIKE_NEW', 'GOOD')
  AND l.price BETWEEN 100 AND 800
  AND c.code = 'UE23CS352A'
ORDER BY l.created_at DESC;

-- ===========================================================================
-- E. Advanced features (views, functions, full-text, vector)
-- ===========================================================================

-- E1. Suspicious bidding (view v_bid_risk): worst pairs first.
SELECT bidder_name, seller_name, total_bids, rapid_bids, last_minute_bids, jump_bids,
       risk_score, risk_level
FROM v_bid_risk
WHERE risk_level <> 'NORMAL'
ORDER BY risk_score DESC;

-- E2. Fair price (function calculate_fair_price) for every active textbook listing.
SELECT l.listing_id, l.title, l.price AS asking_price,
       fp.estimated_price, fp.historical_min, fp.historical_avg, fp.historical_max, fp.sample_size
FROM listing l
CROSS JOIN LATERAL calculate_fair_price(l.book_id, l.item_condition) fp
WHERE l.status = 'ACTIVE' AND l.book_id IS NOT NULL
ORDER BY l.listing_id;

-- E3. Demand analytics (views v_book_demand, v_course_demand).
SELECT title, edition, wishlist_count, search_count_30d, bid_count, swap_request_count,
       available_listings, demand_score, demand_level
FROM v_book_demand
ORDER BY demand_score DESC
LIMIT 10;

SELECT code, name, books_count, available_listings, demand_score, demand_level
FROM v_course_demand
ORDER BY demand_score DESC;

-- E4. Swap matches (recursive CTE inside find_swap_cycles): direct and multi-way swaps.
SELECT swap_type, cycle_length, listing_ids, student_ids
FROM find_swap_cycles(NULL, 4);

-- E5. Waitlist queue in FIFO order (view v_waitlist_queue).
SELECT q.listing_id, l.title, q.queue_position, s.name AS student, q.status, q.claim_expires_at
FROM v_waitlist_queue q
JOIN listing l ON l.listing_id = q.listing_id
JOIN student s ON s.student_id = q.student_id
ORDER BY q.listing_id, q.queue_position;

-- E6. Transaction history of one transaction (audit trail written by trigger).
SELECT h.history_id, h.previous_state, h.new_state, h.changed_by_type, h.changed_by_id, h.changed_at
FROM transaction_state_history h
WHERE h.transaction_id = 1
ORDER BY h.changed_at, h.history_id;

-- E7. Full-text search (tsvector + GIN index), ranked.
SELECT l.listing_id, l.title,
       ts_rank(l.search_vector, q) AS rank
FROM listing l, websearch_to_tsquery('english', 'machine learning') AS q
WHERE l.status = 'ACTIVE' AND l.search_vector @@ q
ORDER BY rank DESC
LIMIT 10;

-- E8. Semantic search with pgvector. The query vector normally comes from the application
--     (embedding of the search text). Here an existing listing's vector is used as the "query":
SELECT *
FROM semantic_search((SELECT embedding FROM listing_embedding ORDER BY listing_id LIMIT 1), 5, NULL);

-- E9. Similar listings ("More like this") and recommendations for student 1.
SELECT * FROM similar_listings(1, 5);
SELECT * FROM recommend_listings(1, 5);

-- E10. Check that the HNSW index exists and is used (look for "Index Scan using idx_listing_embedding_hnsw").
EXPLAIN
SELECT listing_id
FROM listing_embedding
ORDER BY embedding <=> (SELECT embedding FROM listing_embedding ORDER BY listing_id LIMIT 1)
LIMIT 5;

-- ===========================================================================
-- G. Student accounts and book marketplace (release 1)
-- ===========================================================================

-- G1. Students per department and semester, how many verified their college e-mail.
SELECT d.name AS department, s.semester, COUNT(*) AS students,
       COUNT(*) FILTER (WHERE s.email_verified) AS verified
FROM student s JOIN department d ON d.department_id = s.department_id
GROUP BY d.name, s.semester
HAVING COUNT(*) >= 1
ORDER BY d.name, s.semester;

-- G2. Books for a department and semester, cheapest first (filters used by the marketplace).
SELECT d.listing_id, d.title, d.author, d.isbn, d.course_code, d.current_price, d.item_condition
FROM v_listing_details d
WHERE d.status = 'ACTIVE' AND d.department_name = 'CSE' AND d.course_semester = 6
ORDER BY d.current_price;

-- G3. Search by ISBN.
SELECT listing_id, title, current_price FROM v_listing_details WHERE isbn = '9780262046305' AND status = 'ACTIVE';

-- G4. Recently viewed by student 1, newest first.
SELECT l.title, rv.viewed_at
FROM recently_viewed rv JOIN listing l ON l.listing_id = rv.listing_id
WHERE rv.student_id = 1 ORDER BY rv.viewed_at DESC;

-- G5. Mark a book as sold (function), then check that it left the active list.
-- SELECT mark_listing_sold(<listing_id>, <seller_id>);
-- SELECT status FROM listing WHERE listing_id = <listing_id>;

-- G6. The database rejects a non-college e-mail (expected ERROR) and a department change after the first year.
-- INSERT INTO student (srn, name, email, password_hash, department_id, semester)
--   VALUES ('ABCD1234', 'X', 'x@gmail.com', repeat('h', 60), 1, 1);
-- UPDATE student SET department_id = 2 WHERE semester > 2;

-- G7. Verification tokens: only hashes are stored.
SELECT purpose, left(token_hash, 12) AS token_hash_start, expires_at, used_at FROM auth_token ORDER BY created_at DESC LIMIT 5;

-- ===========================================================================
-- F. Transactions, locking and triggers (run inside a transaction and roll back)
-- ===========================================================================

-- F1. Invalid state change is rejected by the trigger (expected ERROR: PENDING -> RELEASED).
-- BEGIN;
-- UPDATE transactions SET state = 'RELEASED' WHERE transaction_id = (SELECT MIN(transaction_id) FROM transactions WHERE state = 'PENDING');
-- ROLLBACK;

-- F2. Anti-sniping: a bid in the last 60 seconds extends the auction by 2 minutes.
-- BEGIN;
-- SELECT * FROM place_bid(<auction_id>, <bidder_id>, <amount>, (SELECT end_time - INTERVAL '30 seconds' FROM auction WHERE auction_id = <auction_id>));
-- ROLLBACK;

-- F3. Row locking: open two psql sessions and run in both:
--   BEGIN; SELECT * FROM auction WHERE auction_id = <id> FOR UPDATE;
-- The second session waits until the first one commits or rolls back.
