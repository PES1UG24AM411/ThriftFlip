import { handle, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";

export const GET = handle(async (req) => {
  await requireAdmin();
  const status = searchParams(req).get("status") ?? "";
  const valid = ["PENDING", "UNDER_REVIEW", "RESOLVED", "DISMISSED"].includes(status) ? status : "";
  return query(
    `SELECT r.report_id, r.reason, r.details, r.status, r.created_at, r.resolved_at,
            rp.name AS reporter_name, st.student_id AS reported_student_id, st.name AS reported_name,
            l.listing_id, l.title AS listing_title
     FROM report r
     JOIN student rp ON rp.student_id = r.reporter_id
     LEFT JOIN student st ON st.student_id = r.reported_student_id
     LEFT JOIN listing l ON l.listing_id = r.reported_listing_id
     WHERE $1 = '' OR r.status = $1
     ORDER BY CASE r.status WHEN 'PENDING' THEN 0 WHEN 'UNDER_REVIEW' THEN 1 ELSE 2 END, r.created_at DESC LIMIT 100`,
    [valid]
  );
});

export const dynamic = "force-dynamic";
