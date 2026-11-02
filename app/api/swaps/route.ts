import { NextResponse } from "next/server";
import { handle, HttpError, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { swapProposeSchema } from "@/lib/validation/schemas";

export const GET = handle(async () => {
  const user = await requireStudent();
  const requests = await query(
    `SELECT r.swap_request_id, r.cycle_id, r.status, r.created_at,
            r.requester_id, rq.name AS requester_name,
            lo.listing_id AS offered_listing_id, lo.title AS offered_title,
            lr.listing_id AS requested_listing_id, lr.title AS requested_title, lr.seller_id AS owner_id, ow.name AS owner_name,
            r.confirmed_at,
            EXISTS (SELECT 1 FROM transactions t WHERE t.swap_request_id = r.swap_request_id) AS has_transaction,
            (lr.seller_id = $1 AND r.status = 'PENDING') AS can_respond
     FROM swap_request r
     JOIN student rq ON rq.student_id = r.requester_id
     JOIN listing lo ON lo.listing_id = r.offered_listing_id
     JOIN listing lr ON lr.listing_id = r.requested_listing_id
     JOIN student ow ON ow.student_id = lr.seller_id
     WHERE r.cycle_id IN (SELECT r2.cycle_id FROM swap_request r2 JOIN listing l2 ON l2.listing_id = r2.requested_listing_id
                          WHERE r2.requester_id = $1 OR l2.seller_id = $1)
     ORDER BY r.created_at DESC, r.cycle_id, r.swap_request_id`,
    [user.id]
  );
  const preferences = await query(
    `SELECT p.preference_id, l.listing_id, l.title AS offered_title, b.book_id, b.title AS wanted_title
     FROM swap_preference p
     JOIN listing l ON l.listing_id = p.offered_listing_id
     JOIN book b ON b.book_id = p.wanted_book_id
     WHERE p.student_id = $1 ORDER BY p.created_at DESC`,
    [user.id]
  );
  const myListings = await query(
    "SELECT listing_id, title FROM listing WHERE seller_id = $1 AND status = 'ACTIVE' AND open_to_swap AND listing_type = 'FIXED_PRICE' ORDER BY title",
    [user.id]
  );
  return { me: user.id, requests, preferences, myListings };
});

// Propose a match. Two students: a normal swap proposal (see /api/swaps/proposals). Three or more: a circle, accepted
// only if it is one of the circles the database finds for me right now (same books, same order), then every
// participant accepts and confirms (see /api/swaps/cycles/[id]).
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const { listingIds } = await parseBody(req, swapProposeSchema);
  if (listingIds.length === 2) {
    const [a, b] = await query("SELECT listing_id, seller_id FROM listing WHERE listing_id = ANY($1::int[])", [listingIds]);
    if (!a || !b) throw new HttpError(404, "Listing not found");
    const mine = a.seller_id === user.id ? a : b;
    const theirs = mine === a ? b : a;
    const made = await query("SELECT propose_swap($1::int, $2::int, $3::int) AS id", [user.id, mine.listing_id, theirs.listing_id]);
    return NextResponse.json({ id: made[0].id }, { status: 201 });
  }
  const found = await query("SELECT listing_ids FROM find_swap_cycles($1::int, 6)", [user.id]);
  if (!found.some((c) => JSON.stringify(c.listing_ids) === JSON.stringify(listingIds))) {
    throw new HttpError(409, "This swap is no longer available. Refresh the page to see current matches.");
  }
  const made = await query("SELECT propose_swap_cycle($1::int[], $2::int) AS id", [listingIds, user.id]);
  return NextResponse.json({ cycleId: made[0].id }, { status: 201 });
});
export const dynamic = "force-dynamic";
