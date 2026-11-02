import { NextResponse } from "next/server";
import { handle, parseBody, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { offerCreateSchema } from "@/lib/validation/schemas";

export const GET = handle(async (req) => {
  const user = await requireStudent();
  const received = searchParams(req).get("scope") === "received";
  return query(
    `SELECT o.offer_id, o.amount, o.message, o.status, o.created_at, l.listing_id, l.title, l.price,
            bu.name AS buyer_name, o.buyer_id
     FROM offer o
     JOIN listing l ON l.listing_id = o.listing_id
     JOIN student bu ON bu.student_id = o.buyer_id
     WHERE ${received ? "l.seller_id" : "o.buyer_id"} = $1
     ORDER BY o.created_at DESC`,
    [user.id]
  );
});

export const POST = handle(async (req) => {
  const user = await requireStudent();
  const b = await parseBody(req, offerCreateSchema);
  const rows = await query(
    "INSERT INTO offer (listing_id, buyer_id, amount, message) VALUES ($1, $2, $3, $4) RETURNING offer_id",
    [b.listingId, user.id, b.amount, b.message ?? null]
  );
  return NextResponse.json({ id: rows[0].offer_id }, { status: 201 });
});

export const dynamic = "force-dynamic";
