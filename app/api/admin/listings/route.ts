import { handle, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";

export const GET = handle(async (req) => {
  await requireAdmin();
  const sp = searchParams(req);
  const q = (sp.get("q") ?? "").trim().slice(0, 100);
  const status = ["ACTIVE", "REMOVED", "SOLD", "RESERVED"].includes(sp.get("status") ?? "") ? sp.get("status")! : "";
  return query(
    `SELECT l.listing_id, l.title, l.status, l.listing_type, l.price, l.created_at, s.student_id AS seller_id, s.name AS seller_name,
            (SELECT COUNT(*)::int FROM report r WHERE r.reported_listing_id = l.listing_id) AS reports
     FROM listing l JOIN student s ON s.student_id = l.seller_id
     WHERE ($1 = '' OR l.title ILIKE '%' || $1 || '%' OR s.name ILIKE '%' || $1 || '%') AND ($2 = '' OR l.status = $2)
     ORDER BY l.created_at DESC LIMIT 100`,
    [q, status]
  );
});

export const dynamic = "force-dynamic";
