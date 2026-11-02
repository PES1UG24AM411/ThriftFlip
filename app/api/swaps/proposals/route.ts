// Direct swap proposals between two students (see db/migrations/010_direct_swaps.sql).
import { NextResponse } from "next/server";
import { handle, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { swapProposalSchema } from "@/lib/validation/schemas";
import { swapActionsFor } from "@/lib/swaps";

// My proposals (sent and received), each with the buttons I may use, plus the listings I could offer.
export const GET = handle(async () => {
  const user = await requireStudent();
  const rows = await query(
    `SELECT p.swap_proposal_id, p.status, p.settlement_amount, p.settlement_payer, p.message,
            p.proposer_id, pr.name AS proposer_name, p.receiver_id, rc.name AS receiver_name,
            p.offered_listing_id, lo.title AS offered_title, p.requested_listing_id, lr.title AS requested_title,
            p.proposer_confirmed_at, p.receiver_confirmed_at, p.created_at, p.responded_at, p.completed_at,
            (SELECT t.transaction_id FROM transactions t WHERE t.swap_proposal_id = p.swap_proposal_id) AS transaction_id
     FROM swap_proposal p
     JOIN student pr ON pr.student_id = p.proposer_id
     JOIN student rc ON rc.student_id = p.receiver_id
     JOIN listing lo ON lo.listing_id = p.offered_listing_id
     JOIN listing lr ON lr.listing_id = p.requested_listing_id
     WHERE p.proposer_id = $1 OR p.receiver_id = $1
     ORDER BY (p.status IN ('PENDING', 'ACCEPTED')) DESC, p.updated_at DESC, p.swap_proposal_id DESC
     LIMIT 100`,
    [user.id]
  );
  const proposals = rows.map((p) => ({ ...p, myRole: p.proposer_id === user.id ? "PROPOSER" : "RECEIVER", actions: swapActionsFor(p, user.id) }));
  const eligibleListings = await query(
    `SELECT listing_id, title, price FROM listing
     WHERE seller_id = $1 AND status = 'ACTIVE' AND listing_type = 'FIXED_PRICE' ORDER BY title`,
    [user.id]
  );
  return { proposals, eligibleListings };
});

// Propose: the DATABASE function checks ownership, availability, self-swap, duplicates and the settlement.
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const b = await parseBody(req, swapProposalSchema);
  const rows = await query("SELECT propose_swap($1::int, $2::int, $3::int, $4::numeric, $5::text, $6::text) AS id", [
    user.id, b.offeredListingId, b.requestedListingId, b.settlementAmount, b.settlementPayer ?? null, b.message ?? null,
  ]);
  return NextResponse.json({ id: rows[0].id }, { status: 201 });
});

export const dynamic = "force-dynamic";
