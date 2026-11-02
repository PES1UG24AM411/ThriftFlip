import { NextResponse } from "next/server";
import { handle, HttpError, parseBody } from "@/lib/http";
import { query, queryOne } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { conversationCreateSchema } from "@/lib/validation/schemas";

export const GET = handle(async () => {
  const user = await requireStudent();
  return query(
    `SELECT c.conversation_id, c.listing_id, l.title,
            CASE WHEN c.buyer_id = $1 THEN se.name ELSE bu.name END AS other_name,
            (SELECT COUNT(*)::int FROM message m
              WHERE m.conversation_id = c.conversation_id AND m.sender_id <> $1 AND m.read_at IS NULL) AS unread,
            (SELECT body FROM message m WHERE m.conversation_id = c.conversation_id ORDER BY m.sent_at DESC, m.message_id DESC LIMIT 1) AS last_message
     FROM conversation c
     JOIN listing l ON l.listing_id = c.listing_id
     JOIN student bu ON bu.student_id = c.buyer_id
     JOIN student se ON se.student_id = c.seller_id
     WHERE c.buyer_id = $1 OR c.seller_id = $1
     ORDER BY c.created_at DESC`,
    [user.id]
  );
});

// Open (or reuse) the conversation between the logged-in buyer and the listing's seller.
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const body = await parseBody(req, conversationCreateSchema);
  if (body.swapProposalId) {
    // swap chat: always the same conversation, on the requested listing, between the proposer and the owner
    const p = await queryOne<{ proposer_id: number; receiver_id: number; requested_listing_id: number }>(
      "SELECT proposer_id, receiver_id, requested_listing_id FROM swap_proposal WHERE swap_proposal_id = $1", [body.swapProposalId]);
    if (!p || (p.proposer_id !== user.id && p.receiver_id !== user.id)) throw new HttpError(404, "Swap proposal not found");
    const rows = await query(
      `INSERT INTO conversation (listing_id, buyer_id, seller_id) VALUES ($1, $2, $3)
       ON CONFLICT (listing_id, buyer_id) DO UPDATE SET listing_id = EXCLUDED.listing_id RETURNING conversation_id`,
      [p.requested_listing_id, p.proposer_id, p.receiver_id]
    );
    return NextResponse.json({ id: rows[0].conversation_id }, { status: 201 });
  }
  const listingId = body.listingId!;
  const listing = await queryOne<{ seller_id: number }>("SELECT seller_id FROM listing WHERE listing_id = $1", [listingId]);
  if (!listing) throw new HttpError(404, "Listing not found");
  if (listing.seller_id === user.id) throw new HttpError(400, "This is your own listing");
  const rows = await query(
    `INSERT INTO conversation (listing_id, buyer_id, seller_id) VALUES ($1, $2, $3)
     ON CONFLICT (listing_id, buyer_id) DO UPDATE SET listing_id = EXCLUDED.listing_id
     RETURNING conversation_id`,
    [listingId, user.id, listing.seller_id]
  );
  return NextResponse.json({ id: rows[0].conversation_id }, { status: 201 });
});

export const dynamic = "force-dynamic";
