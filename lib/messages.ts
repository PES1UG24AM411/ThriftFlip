// Reading a chat. Used by GET /api/conversations/[id], which the Messages page asks again every 2 seconds
// while a chat is open, so "read" really means "it was on the reader's screen".
import type { Pool, PoolClient } from "pg";

/**
 * Marks the other student's messages in this chat as read and also the "New message" notification of this chat,
 * so the bell does not keep counting messages the student is looking at.
 * Only that student's own rows are changed (the sender's messages are never touched).
 */
export async function markConversationRead(db: Pool | PoolClient, conversationId: number, studentId: number): Promise<void> {
  await db.query("UPDATE message SET read_at = now() WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL", [conversationId, studentId]);
  await db.query(
    "UPDATE notification SET is_read = true WHERE student_id = $1 AND type = 'MESSAGE' AND related_conversation_id = $2 AND NOT is_read",
    [studentId, conversationId]
  );
}
