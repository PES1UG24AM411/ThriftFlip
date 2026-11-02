-- 011_reputation.sql
-- Rule-based, transparent reputation (0..100). See docs/REPUTATION.md.
--
--   completed_transactions  number of DEALS the student finished (state RELEASED). A deal counts once per student,
--                           also when it consists of several transaction rows (multi-way swap cycle) and also
--                           when the student is buyer in one row and seller in another.
--   rating_count, avg_rating  ratings the student RECEIVED for finished deals.
--
--   deal points    = 5 * min(completed_transactions, 10)                      max 50
--   rating points  = 10 * avg_rating * min(rating_count, 5) / 5               max 50   (5 ratings needed for full weight)
--   penalty        = 10 * upheld reports
--   reputation     = 0 when completed_transactions = 0, otherwise clamp(deal + rating - penalty, 0, 100)
--
-- So a new account (no finished deal) is exactly 0; browsing, listing, offers, bids, proposals,
-- cancelled/rejected/expired deals and account age never add points.

CREATE OR REPLACE VIEW v_student_reputation AS
WITH released AS (
    SELECT t.transaction_id, t.buyer_id, t.seller_id, t.transaction_type,
           COALESCE('C' || sr.cycle_id::text, 'P' || t.swap_proposal_id::text, 'T' || t.transaction_id::text) AS deal_key,
           (t.transaction_type = 'SWAP') AS is_swap
    FROM transactions t
    LEFT JOIN swap_request sr ON sr.swap_request_id = t.swap_request_id
    WHERE t.state = 'RELEASED'
      -- a multi-way cycle only counts when EVERY transaction of the cycle is released
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
    COALESCE(r.rating_count, 0) AS rating_count,
    ROUND(r.avg_rating, 2) AS avg_rating,
    COALESCE(d.completed_sales, 0) AS completed_sales,
    COALESCE(d.completed_swaps, 0) AS completed_swaps,
    COALESCE(rp.upheld_reports, 0) AS upheld_reports,
    CASE WHEN COALESCE(d.completed_sales, 0) + COALESCE(d.completed_swaps, 0) = 0 THEN 0
         ELSE GREATEST(0, LEAST(100, ROUND(
              5 * LEAST(COALESCE(d.completed_sales, 0) + COALESCE(d.completed_swaps, 0), 10)
            + 10 * COALESCE(r.avg_rating, 0) * LEAST(COALESCE(r.rating_count, 0), 5) / 5.0
            - 10 * COALESCE(rp.upheld_reports, 0))))::INTEGER
    END AS reputation_score,
    (COALESCE(d.completed_sales, 0) + COALESCE(d.completed_swaps, 0))::INTEGER AS completed_transactions
FROM student s
LEFT JOIN ratings r ON r.ratee_id = s.student_id
LEFT JOIN deal_counts d ON d.student_id = s.student_id
LEFT JOIN (
    SELECT reported_student_id, COUNT(*) AS upheld_reports
    FROM report
    WHERE status IN ('WARNED', 'LISTING_REMOVED', 'USER_SUSPENDED')
    GROUP BY reported_student_id
) rp ON rp.reported_student_id = s.student_id;

-- Feedback only for a FINISHED deal (state RELEASED), only between its two participants, once per rater.
-- (self-rating is also blocked by ck_rating_not_self, duplicates by UNIQUE (transaction_id, rater_id))
CREATE OR REPLACE FUNCTION validate_rating() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_tx transactions%ROWTYPE;
BEGIN
    SELECT * INTO v_tx FROM transactions WHERE transaction_id = NEW.transaction_id;
    IF v_tx.state IS DISTINCT FROM 'RELEASED' THEN
        RAISE EXCEPTION 'Only completed transactions can be rated' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.rater_id = NEW.ratee_id THEN
        RAISE EXCEPTION 'You cannot rate yourself' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((NEW.rater_id = v_tx.buyer_id AND NEW.ratee_id = v_tx.seller_id)
         OR (NEW.rater_id = v_tx.seller_id AND NEW.ratee_id = v_tx.buyer_id)) THEN
        RAISE EXCEPTION 'Only the buyer and seller of the transaction can rate each other' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;
