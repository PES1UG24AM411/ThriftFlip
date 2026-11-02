-- 004_views.sql
-- Views used by the application (dashboards, analytics, fraud detection).

-- ---------------------------------------------------------------------------
-- Demand classification used by v_book_demand and v_course_demand.
-- ratio = demand_score / max(available_listings, 1)
--   HIGH   : ratio >= 6
--   MEDIUM : ratio >= 2
--   LOW    : otherwise
-- ---------------------------------------------------------------------------
CREATE FUNCTION demand_level(p_score INTEGER, p_available INTEGER)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_score::numeric / GREATEST(p_available, 1) >= 6 THEN 'HIGH'
        WHEN p_score::numeric / GREATEST(p_available, 1) >= 2 THEN 'MEDIUM'
        ELSE 'LOW'
    END
$$;

-- ---------------------------------------------------------------------------
-- Student reputation: ratings + completed deals - upheld reports.
--   score = avg_rating*16 (max 80; 3.0 assumed when never rated)
--         + min(completed deals, 10)*2 (max 20)
--         - 5 * upheld reports, limited to 0..100
-- ---------------------------------------------------------------------------
CREATE VIEW v_student_reputation AS
SELECT
    s.student_id,
    s.name,
    COALESCE(r.rating_count, 0) AS rating_count,
    ROUND(r.avg_rating, 2) AS avg_rating,
    COALESCE(t.completed_sales, 0) AS completed_sales,
    COALESCE(t.completed_swaps, 0) AS completed_swaps,
    COALESCE(rp.upheld_reports, 0) AS upheld_reports,
    GREATEST(0, LEAST(100, ROUND(
        COALESCE(r.avg_rating, 3) * 16
        + LEAST(COALESCE(t.completed_sales, 0) + COALESCE(t.completed_swaps, 0), 10) * 2
        - 5 * COALESCE(rp.upheld_reports, 0)
    )))::INTEGER AS reputation_score
FROM student s
LEFT JOIN (
    SELECT ratee_id, AVG(score) AS avg_rating, COUNT(*) AS rating_count
    FROM rating
    GROUP BY ratee_id
) r ON r.ratee_id = s.student_id
LEFT JOIN (
    SELECT student_id,
           COUNT(*) FILTER (WHERE transaction_type <> 'SWAP') AS completed_sales,
           COUNT(*) FILTER (WHERE transaction_type = 'SWAP') AS completed_swaps
    FROM (
        SELECT buyer_id AS student_id, transaction_type FROM transactions WHERE state = 'RELEASED'
        UNION ALL
        SELECT seller_id AS student_id, transaction_type FROM transactions WHERE state = 'RELEASED'
    ) deals
    GROUP BY student_id
) t ON t.student_id = s.student_id
LEFT JOIN (
    SELECT reported_student_id, COUNT(*) AS upheld_reports
    FROM report
    WHERE status IN ('WARNED', 'LISTING_REMOVED', 'USER_SUSPENDED')
    GROUP BY reported_student_id
) rp ON rp.reported_student_id = s.student_id;

-- ---------------------------------------------------------------------------
-- Listing details: listing + book + course + seller + campus + auction + reputation
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Auction status: highest bidder, number of bids, time left
-- ---------------------------------------------------------------------------
CREATE VIEW v_auction_status AS
SELECT
    a.auction_id, a.listing_id, l.title, l.seller_id,
    a.starting_price, a.min_increment, a.current_price,
    a.highest_bidder_id, hb.name AS highest_bidder_name,
    a.start_time, a.end_time, a.original_end_time, a.extension_count,
    a.status, a.winner_id,
    (SELECT COUNT(*) FROM bid b WHERE b.auction_id = a.auction_id AND b.status = 'VALID') AS bid_count,
    GREATEST(EXTRACT(EPOCH FROM (a.end_time - now())), 0)::INTEGER AS seconds_left
FROM auction a
JOIN listing l ON l.listing_id = a.listing_id
LEFT JOIN student hb ON hb.student_id = a.highest_bidder_id;

-- ---------------------------------------------------------------------------
-- Price history: every finished sale or auction (swaps have no price)
-- ---------------------------------------------------------------------------
CREATE VIEW v_price_history AS
SELECT
    b.book_id, b.title, b.author, b.edition, b.subject, b.course_id,
    l.item_condition, t.amount, t.transaction_type, t.updated_at AS sold_at
FROM transactions t
JOIN listing l ON l.listing_id = t.listing_id
JOIN book b ON b.book_id = l.book_id
WHERE t.state IN ('CONFIRMED', 'RELEASED') AND t.transaction_type <> 'SWAP';

CREATE VIEW v_book_price_stats AS
SELECT book_id, title, edition,
       COUNT(*) AS sales_count,
       MIN(amount) AS min_price,
       ROUND(AVG(amount), 2) AS avg_price,
       MAX(amount) AS max_price
FROM v_price_history
GROUP BY book_id, title, edition;

-- ---------------------------------------------------------------------------
-- Suspicious bidding analysis (rule based, computed from stored bids).
-- One row per (bidder, seller) pair. Signals:
--   rapid_bids         : bidder bid again within 30 s of their own previous bid in the same auction
--   last_minute_bids   : bids placed in the final 60 s of an auction
--   jump_bids          : bid at least 5x the minimum increment above the previous bid
--   repeated interplay : bidder bid on several auctions of the same seller
--   heavy bidding      : 15 or more bids on this seller
-- risk_score = 3*rapid + 2*last_minute + 2*jump + 3*(auctions-1) + 5 if heavy
-- NORMAL < 7 <= SUSPICIOUS < 15 <= HIGH_RISK
-- All bids are analysed (including CANCELLED ones) so cancelling cannot hide a pattern.
-- ---------------------------------------------------------------------------
CREATE VIEW v_bid_risk AS
SELECT
    x.*,
    CASE WHEN x.risk_score >= 15 THEN 'HIGH_RISK'
         WHEN x.risk_score >= 7 THEN 'SUSPICIOUS'
         ELSE 'NORMAL' END AS risk_level
FROM (
    SELECT
        ps.bidder_id, bd.name AS bidder_name,
        ps.seller_id, sl.name AS seller_name,
        ps.total_bids, ps.auctions_bid_on, ps.rapid_bids, ps.last_minute_bids, ps.jump_bids,
        (3 * ps.rapid_bids + 2 * ps.last_minute_bids + 2 * ps.jump_bids
         + 3 * GREATEST(ps.auctions_bid_on - 1, 0)
         + CASE WHEN ps.total_bids >= 15 THEN 5 ELSE 0 END)::INTEGER AS risk_score
    FROM (
        SELECT
            q.bidder_id, q.seller_id,
            COUNT(*)::INTEGER AS total_bids,
            COUNT(DISTINCT q.auction_id)::INTEGER AS auctions_bid_on,
            (COUNT(*) FILTER (WHERE q.gap_since_own_prev_bid <= INTERVAL '30 seconds'))::INTEGER AS rapid_bids,
            (COUNT(*) FILTER (WHERE q.seconds_before_end <= 60))::INTEGER AS last_minute_bids,
            (COUNT(*) FILTER (WHERE q.increment_over_prev >= 5 * q.min_increment))::INTEGER AS jump_bids
        FROM (
            SELECT
                b.auction_id, b.bidder_id, b.seconds_before_end,
                l.seller_id, a.min_increment,
                b.placed_at - LAG(b.placed_at) OVER (PARTITION BY b.auction_id, b.bidder_id ORDER BY b.placed_at, b.bid_id) AS gap_since_own_prev_bid,
                b.amount - LAG(b.amount) OVER (PARTITION BY b.auction_id ORDER BY b.placed_at, b.bid_id) AS increment_over_prev
            FROM bid b
            JOIN auction a ON a.auction_id = b.auction_id
            JOIN listing l ON l.listing_id = a.listing_id
        ) q
        GROUP BY q.bidder_id, q.seller_id
    ) ps
    JOIN student bd ON bd.student_id = ps.bidder_id
    JOIN student sl ON sl.student_id = ps.seller_id
) x;

-- ---------------------------------------------------------------------------
-- Demand analytics from real activity.
--   demand_score = 2*wishlist + searches/views in last 30 days + bids + 2*swap requests
-- ---------------------------------------------------------------------------
CREATE VIEW v_book_demand AS
SELECT
    d.*,
    demand_level(d.demand_score, d.available_listings) AS demand_level
FROM (
    SELECT
        b.book_id, b.title, b.edition, b.course_id,
        COALESCE(w.cnt, 0)::INTEGER AS wishlist_count,
        COALESCE(sa.cnt, 0)::INTEGER AS search_count_30d,
        COALESCE(bd.cnt, 0)::INTEGER AS bid_count,
        COALESCE(sw.cnt, 0)::INTEGER AS swap_request_count,
        COALESCE(av.cnt, 0)::INTEGER AS available_listings,
        (2 * COALESCE(w.cnt, 0) + COALESCE(sa.cnt, 0) + COALESCE(bd.cnt, 0) + 2 * COALESCE(sw.cnt, 0))::INTEGER AS demand_score
    FROM book b
    LEFT JOIN (
        SELECT l.book_id, COUNT(*) AS cnt
        FROM wishlist wl JOIN listing l ON l.listing_id = wl.listing_id
        GROUP BY l.book_id
    ) w ON w.book_id = b.book_id
    LEFT JOIN (
        SELECT book_id, COUNT(*) AS cnt
        FROM search_activity
        WHERE book_id IS NOT NULL AND searched_at >= now() - INTERVAL '30 days'
        GROUP BY book_id
    ) sa ON sa.book_id = b.book_id
    LEFT JOIN (
        SELECT l.book_id, COUNT(*) AS cnt
        FROM bid bi JOIN auction a ON a.auction_id = bi.auction_id JOIN listing l ON l.listing_id = a.listing_id
        GROUP BY l.book_id
    ) bd ON bd.book_id = b.book_id
    LEFT JOIN (
        SELECT l.book_id, COUNT(*) AS cnt
        FROM swap_request sr JOIN listing l ON l.listing_id = sr.requested_listing_id
        GROUP BY l.book_id
    ) sw ON sw.book_id = b.book_id
    LEFT JOIN (
        SELECT book_id, COUNT(*) AS cnt
        FROM listing
        WHERE status = 'ACTIVE' AND book_id IS NOT NULL
        GROUP BY book_id
    ) av ON av.book_id = b.book_id
) d;

CREATE VIEW v_course_demand AS
SELECT
    d.*,
    demand_level(d.demand_score, d.available_listings) AS demand_level
FROM (
    SELECT
        c.course_id, c.code, c.name,
        COUNT(bd.book_id)::INTEGER AS books_count,
        COALESCE(SUM(bd.wishlist_count), 0)::INTEGER AS wishlist_count,
        COALESCE(SUM(bd.available_listings), 0)::INTEGER AS available_listings,
        COALESCE(SUM(bd.demand_score), 0)::INTEGER AS demand_score
    FROM course c
    LEFT JOIN v_book_demand bd ON bd.course_id = c.course_id
    GROUP BY c.course_id, c.code, c.name
) d;

-- ---------------------------------------------------------------------------
-- Waitlist queue with FIFO position
-- ---------------------------------------------------------------------------
CREATE VIEW v_waitlist_queue AS
SELECT
    w.waitlist_id, w.listing_id, w.student_id, w.status, w.joined_at,
    w.notified_at, w.claim_expires_at,
    ROW_NUMBER() OVER (PARTITION BY w.listing_id ORDER BY w.joined_at, w.waitlist_id) AS queue_position
FROM waitlist w
WHERE w.status IN ('WAITING', 'NOTIFIED');

-- ---------------------------------------------------------------------------
-- Admin overview (one row of live counters)
-- ---------------------------------------------------------------------------
CREATE VIEW v_admin_overview AS
SELECT
    (SELECT COUNT(*) FROM student) AS total_students,
    (SELECT COUNT(*) FROM student WHERE status = 'SUSPENDED') AS suspended_students,
    (SELECT COUNT(*) FROM listing WHERE status = 'ACTIVE') AS active_listings,
    (SELECT COUNT(*) FROM auction WHERE status = 'ACTIVE') AS active_auctions,
    (SELECT COUNT(*) FROM transactions WHERE state = 'RELEASED') AS completed_transactions,
    (SELECT COUNT(*) FROM transactions WHERE state NOT IN ('RELEASED', 'CANCELLED')) AS open_transactions,
    (SELECT COUNT(*) FROM report WHERE status = 'OPEN') AS open_reports,
    (SELECT COUNT(*) FROM v_bid_risk WHERE risk_level <> 'NORMAL') AS flagged_bidder_pairs,
    (SELECT COUNT(*) FROM waitlist WHERE status IN ('WAITING', 'NOTIFIED')) AS waitlist_entries,
    (SELECT COUNT(*) FROM swap_request WHERE status IN ('PENDING', 'ACCEPTED')) AS open_swap_requests,
    (SELECT ROUND(AVG(amount), 2) FROM v_price_history) AS avg_sale_price;
