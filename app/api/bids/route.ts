import { NextResponse } from "next/server";
import { handle, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { bidSchema } from "@/lib/validation/schemas";

// place_bid() locks the auction row (SELECT ... FOR UPDATE), validates the bid (trigger),
// raises the price and applies anti-sniping (+2 minutes when the bid arrives in the last 60 s).
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const { auctionId, amount } = await parseBody(req, bidSchema);
  const rows = await query("SELECT * FROM place_bid($1::int, $2::int, $3::numeric)", [auctionId, user.id, amount]);
  const r = rows[0];
  return NextResponse.json(
    { bidId: r.out_bid_id, endTime: r.out_end_time, extended: r.out_extended, currentPrice: r.out_price },
    { status: 201 }
  );
});

export const dynamic = "force-dynamic";
