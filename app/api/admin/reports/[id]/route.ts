import { handle, HttpError, parseBody, parseId } from "@/lib/http";
import { query, queryOne } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";
import { adminReportStatusSchema } from "@/lib/validation/schemas";

// Everything an admin needs to judge one report: the report, the evidence (reported listing, reporter's details,
// the reported student's history), what admins already did, and the messages exchanged about it.
export const GET = handle(async (_req, ctx) => {
  await requireAdmin();
  const id = parseId(ctx.params.id);
  const report = await queryOne(
    `SELECT r.report_id, r.reason, r.details, r.status, r.created_at, r.resolved_at, ad.name AS resolved_by_name,
            rp.student_id AS reporter_id, rp.name AS reporter_name,
            st.student_id AS reported_student_id, st.name AS reported_name, st.status AS reported_status, st.warning_count AS reported_warnings,
            l.listing_id, l.title AS listing_title, l.description AS listing_description, l.status AS listing_status, l.price AS listing_price
     FROM report r
     JOIN student rp ON rp.student_id = r.reporter_id
     LEFT JOIN student st ON st.student_id = r.reported_student_id
     LEFT JOIN listing l ON l.listing_id = r.reported_listing_id
     LEFT JOIN admin ad ON ad.admin_id = r.resolved_by
     WHERE r.report_id = $1`,
    [id]
  );
  if (!report) throw new HttpError(404, "Report not found");
  const actions = await query(
    `SELECT a.action_id, a.action, a.reason, a.created_at, ad.name AS admin_name
     FROM admin_action a JOIN admin ad ON ad.admin_id = a.admin_id WHERE a.report_id = $1 ORDER BY a.created_at, a.action_id`,
    [id]
  );
  const messages = await query(
    `SELECT m.admin_message_id, m.sender_type, m.kind, m.body, m.created_at, ad.name AS admin_name, s.name AS student_name
     FROM admin_message m JOIN student s ON s.student_id = m.student_id LEFT JOIN admin ad ON ad.admin_id = m.admin_id
     WHERE m.report_id = $1 ORDER BY m.created_at, m.admin_message_id`,
    [id]
  );
  const otherReports = report.reported_student_id
    ? (await queryOne("SELECT COUNT(*)::int AS n FROM report WHERE reported_student_id = $1 AND report_id <> $2", [report.reported_student_id, id]))?.n ?? 0
    : 0;
  // replies from the student count as read once an admin opens the report
  await query("UPDATE admin_message SET is_read = true WHERE report_id = $1 AND sender_type = 'STUDENT' AND NOT is_read", [id]);
  return { report, actions, messages, otherReports };
});

// Move the report along: Pending -> Under review -> Resolved / Dismissed (the database checks the order).
export const POST = handle(async (req, ctx) => {
  const admin = await requireAdmin();
  const b = await parseBody(req, adminReportStatusSchema);
  await query("SELECT admin_set_report_status($1::int, $2::int, $3::text, $4::text)", [admin.id, parseId(ctx.params.id), b.status, b.reason]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
