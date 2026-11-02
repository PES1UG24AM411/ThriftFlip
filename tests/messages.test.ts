// Reading a chat (lib/messages.ts, used by GET /api/conversations/[id]): the other student's messages AND the chat's
// "New message" notification become read, nothing else does, and the next message notifies again.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { markConversationRead } from "../lib/messages";
import { makeBook, makeListing, makeStudent, one, pool, resetData, setupCampus } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

async function chat(buyer: number, seller: number) {
  const book = await makeBook(base.course);
  const listing = await makeListing(seller, base.campus, book);
  return (await one("INSERT INTO conversation (listing_id, buyer_id, seller_id) VALUES ($1, $2, $3) RETURNING conversation_id", [listing, buyer, seller])).conversation_id as number;
}
const say = (conversation: number, sender: number, body = "hello") =>
  pool.query("INSERT INTO message (conversation_id, sender_id, body) VALUES ($1, $2, $3)", [conversation, sender, body]);
const unreadMessages = async (conversation: number, forStudent: number) =>
  (await one("SELECT COUNT(*)::int AS n FROM message WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL", [conversation, forStudent])).n as number;
const unreadNotifications = async (student: number, conversation?: number) =>
  (await one(
    "SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'MESSAGE' AND NOT is_read AND ($2::int IS NULL OR related_conversation_id = $2::int)",
    [student, conversation ?? null]
  )).n as number;

describe("markConversationRead", () => {
  it("marks the other student's messages and this chat's notification as read", async () => {
    const buyer = await makeStudent(base), seller = await makeStudent(base);
    const c = await chat(buyer, seller);
    await say(c, buyer); await say(c, buyer);
    expect(await unreadMessages(c, seller)).toBe(2);
    expect(await unreadNotifications(seller, c)).toBe(1); // one notification per chat while unread

    await markConversationRead(pool, c, seller);

    expect(await unreadMessages(c, seller)).toBe(0);
    expect(await unreadNotifications(seller, c)).toBe(0);
  });

  it("does not touch other chats, the sender's own messages or other students", async () => {
    const buyer = await makeStudent(base), seller = await makeStudent(base);
    const c1 = await chat(buyer, seller), c2 = await chat(buyer, seller);
    await say(c1, buyer); await say(c2, buyer);
    await say(c1, seller, "reply"); // unread for the buyer

    await markConversationRead(pool, c1, seller);

    expect(await unreadNotifications(seller, c2)).toBe(1); // other chat: still unread
    expect(await unreadMessages(c2, seller)).toBe(1);
    expect(await unreadMessages(c1, buyer)).toBe(1); // the seller reading must not mark the buyer's unread reply
    expect(await unreadNotifications(buyer, c1)).toBe(1); // ... nor the buyer's notification
  });

  it("a message sent after reading notifies again", async () => {
    const buyer = await makeStudent(base), seller = await makeStudent(base);
    const c = await chat(buyer, seller);
    await say(c, buyer);
    await markConversationRead(pool, c, seller);
    expect(await unreadNotifications(seller, c)).toBe(0);

    await say(c, buyer, "are you there?");
    expect(await unreadNotifications(seller, c)).toBe(1);
    expect(await unreadMessages(c, seller)).toBe(1);
  });

  it("is safe to repeat (the page asks every 2 seconds)", async () => {
    const buyer = await makeStudent(base), seller = await makeStudent(base);
    const c = await chat(buyer, seller);
    await say(c, buyer);
    for (let i = 0; i < 3; i++) await markConversationRead(pool, c, seller);
    expect(await unreadMessages(c, seller)).toBe(0);
    expect(await unreadNotifications(seller)).toBe(0);
  });
});
