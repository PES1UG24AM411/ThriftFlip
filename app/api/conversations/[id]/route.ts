import { NextResponse } from "next/server";
import { handle, HttpError, parseBody, parseId } from "@/lib/http";
import { pool, query, queryOne } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { markConversationRead } from "@/lib/messages";
import { messageSchema } from "@/lib/validation/schemas";

async function loadConversation(id: number, studentId: number) {
  const conv = await queryOne("SELECT * FROM conversation WHERE conversation_id = $1 AND (buyer_id = $2 OR seller_id = $2)", [id, studentId]);
  if (!conv) throw new HttpError(404, "Conversation not found");
  return conv;
}

export const GET = handle(async (_req, ctx) => {
  const user = await requireStudent();
  const id = parseId(ctx.params.id);
  await loadConversation(id, user.id);
  await markConversationRead(pool, id, user.id); // also clears this chat's "New message" notification
  return query(
    `SELECT m.message_id, m.body, m.sent_at, m.sender_id, s.name AS sender_name
     FROM message m JOIN student s ON s.student_id = m.sender_id
     WHERE m.conversation_id = $1 ORDER BY m.sent_at, m.message_id`,
    [id]
  );
});

export const POST = handle(async (req, ctx) => {
  const user = await requireStudent();
  const id = parseId(ctx.params.id);
  await loadConversation(id, user.id);
  const { body } = await parseBody(req, messageSchema);
  await query("INSERT INTO message (conversation_id, sender_id, body) VALUES ($1, $2, $3)", [id, user.id, body]);
  return NextResponse.json({ ok: true }, { status: 201 });
});

export const dynamic = "force-dynamic";
