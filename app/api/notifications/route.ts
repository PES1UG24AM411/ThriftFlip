import { handle, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { notificationReadSchema } from "@/lib/validation/schemas";

export const GET = handle(async () => {
  const user = await requireStudent();
  const items = await query(
    `SELECT notification_id, type, title, body, related_listing_id, is_read, created_at
     FROM notification WHERE student_id = $1 ORDER BY created_at DESC, notification_id DESC LIMIT 50`,
    [user.id]
  );
  const unread = await query("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND NOT is_read", [user.id]);
  return { items, unread: unread[0].n };
});

// body {id} marks one notification as read, an empty body {} marks all of them
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const { id } = await parseBody(req, notificationReadSchema);
  await query(
    "UPDATE notification SET is_read = true WHERE student_id = $1 AND ($2::int IS NULL OR notification_id = $2::int)",
    [user.id, id ?? null]
  );
  return { ok: true };
});

export const dynamic = "force-dynamic";
