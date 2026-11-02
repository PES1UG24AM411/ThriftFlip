import { NextResponse } from "next/server";
import { handle, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { purchaseSchema } from "@/lib/validation/schemas";

export const GET = handle(async () => {
  const user = await requireStudent();
  return query(
    `SELECT t.transaction_id, t.state, t.amount, t.transaction_type, t.created_at, t.updated_at,
            l.listing_id, l.title, bu.name AS buyer_name, se.name AS seller_name,
            lo.title AS swapped_for_title, sp.settlement_amount,
            CASE WHEN t.buyer_id = $1 THEN 'BUYER' ELSE 'SELLER' END AS my_role
     FROM transactions t
     JOIN listing l ON l.listing_id = t.listing_id
     LEFT JOIN swap_proposal sp ON sp.swap_proposal_id = t.swap_proposal_id
     LEFT JOIN listing lo ON lo.listing_id = sp.offered_listing_id
     JOIN student bu ON bu.student_id = t.buyer_id
     JOIN student se ON se.student_id = t.seller_id
     WHERE t.buyer_id = $1 OR t.seller_id = $1
     ORDER BY t.updated_at DESC`,
    [user.id]
  );
});

// Buy a fixed-price listing: create_purchase() locks the listing row so two buyers cannot both succeed.
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const { listingId } = await parseBody(req, purchaseSchema);
  const rows = await query("SELECT create_purchase($1::int, $2::int) AS id", [listingId, user.id]);
  return NextResponse.json({ transactionId: rows[0].id }, { status: 201 });
});

export const dynamic = "force-dynamic";
