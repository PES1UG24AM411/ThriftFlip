import { NextResponse } from "next/server";
import { handle, HttpError, parseBody } from "@/lib/http";
import { query, queryOne } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { noticeReplySchema } from "@/lib/validation/schemas";

// "Messages from admins": the official messages, warnings and notices sent to me, and my replies.
export const GET = handle(async () => {
  const user = await requireStudent();
  const items = await query(
    `SELECT m.admin_message_id, m.sender_type, m.kind, m.body, m.report_id, m.listing_id, l.title AS listing_title, m.is_read, m.created_at
     FROM admin_message m LEFT JOIN listing l ON l.listing_id = m.listing_id
     WHERE m.student_id = $1 ORDER BY m.created_at DESC, m.admin_message_id DESC LIMIT 100`,
    [user.id]
  );
  await query("UPDATE admin_message SET is_read = true WHERE student_id = $1 AND sender_type = 'ADMIN' AND NOT is_read", [user.id]);
  return items;
});

// Reply to the admins. A reply may only be about a report or listing the admins already wrote to me about.
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const b = await parseBody(req, noticeReplySchema);
  if (!(await queryOne("SELECT 1 FROM admin_message WHERE student_id = $1 AND sender_type = 'ADMIN' LIMIT 1", [user.id]))) {
    throw new HttpError(403, "There is no message from the admins to answer");
  }
  if (b.reportId && !(await queryOne("SELECT 1 FROM admin_message WHERE student_id = $1 AND report_id = $2 AND sender_type = 'ADMIN'", [user.id, b.reportId]))) {
    throw new HttpError(403, "That report is not about you");
  }
  if (b.listingId && !(await queryOne("SELECT 1 FROM listing WHERE listing_id = $1 AND seller_id = $2", [b.listingId, user.id]))) {
    throw new HttpError(403, "That is not your listing");
  }
  const rows = await query(
    `INSERT INTO admin_message (student_id, sender_type, report_id, listing_id, kind, body)
     VALUES ($1, 'STUDENT', $2, $3, 'MESSAGE', $4) RETURNING admin_message_id`,
    [user.id, b.reportId ?? null, b.listingId ?? null, b.body]
  );
  return NextResponse.json({ id: rows[0].admin_message_id }, { status: 201 });
});

export const dynamic = "force-dynamic";
