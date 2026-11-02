// Admin dashboard data. Every number comes from SQL views/aggregates, nothing is hard-coded.
import { handle } from "@/lib/http";
import { query, queryOne } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";

export const GET = handle(async () => {
  await requireAdmin();
  await query("SELECT close_expired_auctions()");
  const [overview, suspicious, popularBooks, demandBooks, demandCourses, avgPrices, auctionStats,
    swapStats, waitlistStats, txStats, activeUsers] = await Promise.all([
    queryOne("SELECT * FROM v_admin_overview"),
    query("SELECT * FROM v_bid_risk WHERE risk_level <> 'NORMAL' ORDER BY risk_score DESC LIMIT 20"),
    query(`SELECT b.title, COUNT(*)::int AS wishlisted FROM wishlist w
           JOIN listing l ON l.listing_id = w.listing_id JOIN book b ON b.book_id = l.book_id
           GROUP BY b.book_id, b.title ORDER BY wishlisted DESC LIMIT 5`),
    query("SELECT title, edition, demand_score, demand_level FROM v_book_demand ORDER BY demand_score DESC LIMIT 8"),
    query("SELECT code, name, available_listings, demand_score, demand_level FROM v_course_demand ORDER BY demand_score DESC LIMIT 8"),
    query("SELECT subject, COUNT(*)::int AS sales, ROUND(AVG(amount), 2) AS avg_price FROM v_price_history GROUP BY subject ORDER BY sales DESC"),
    queryOne(`SELECT COUNT(*)::int AS total,
                     COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                     COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed,
                     COALESCE(SUM(extension_count), 0)::int AS anti_snipe_extensions,
                     (SELECT COUNT(*)::int FROM bid) AS bids
              FROM auction`),
    queryOne(`SELECT COUNT(DISTINCT cycle_id)::int AS proposals,
                     COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                     COUNT(*) FILTER (WHERE status = 'ACCEPTED')::int AS accepted,
                     COUNT(*) FILTER (WHERE status IN ('REJECTED', 'CANCELLED'))::int AS declined,
                     (SELECT COUNT(*)::int FROM find_swap_cycles(NULL, 4)) AS possible_cycles
              FROM swap_request`),
    query("SELECT status, COUNT(*)::int AS entries FROM waitlist GROUP BY status ORDER BY status"),
    query("SELECT state, COUNT(*)::int AS transactions FROM transactions GROUP BY state ORDER BY state"),
    queryOne(`SELECT COUNT(*)::int AS n FROM student s WHERE
                EXISTS (SELECT 1 FROM bid b WHERE b.bidder_id = s.student_id AND b.placed_at > now() - INTERVAL '30 days')
             OR EXISTS (SELECT 1 FROM listing l WHERE l.seller_id = s.student_id AND l.created_at > now() - INTERVAL '30 days')
             OR EXISTS (SELECT 1 FROM search_activity a WHERE a.student_id = s.student_id AND a.searched_at > now() - INTERVAL '30 days')`),
  ]);
  return { overview, suspicious, popularBooks, demandBooks, demandCourses, avgPrices, auctionStats,
    swapStats, waitlistStats, txStats, activeUsers: activeUsers?.n ?? 0 };
});

export const dynamic = "force-dynamic";
