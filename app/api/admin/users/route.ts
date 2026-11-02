import { handle, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";

export const GET = handle(async (req) => {
  await requireAdmin();
  const q = (searchParams(req).get("q") ?? "").trim().slice(0, 100);
  return query(
    `SELECT s.student_id, s.name, s.email, s.status, s.warning_count, s.created_at,
            (SELECT COUNT(*)::int FROM listing l WHERE l.seller_id = s.student_id AND l.status = 'ACTIVE') AS active_listings,
            (SELECT COUNT(*)::int FROM report r WHERE r.reported_student_id = s.student_id) AS reports_against,
            rt.avg_rating, rt.rating_count
     FROM student s JOIN v_student_ratings rt ON rt.student_id = s.student_id
     WHERE $1 = '' OR s.name ILIKE '%' || $1 || '%' OR s.email ILIKE '%' || $1 || '%'
     ORDER BY (s.status = 'SUSPENDED') DESC, s.name LIMIT 100`,
    [q]
  );
});

export const dynamic = "force-dynamic";
