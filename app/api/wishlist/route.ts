import { NextResponse } from "next/server";
import { handle, parseBody, parseId, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { listingRefSchema } from "@/lib/validation/schemas";
import { LISTING_CARD_COLUMNS } from "@/lib/sql";

export const GET = handle(async () => {
  const user = await requireStudent();
  return query(
    `SELECT ${LISTING_CARD_COLUMNS}, w.created_at AS saved_at
     FROM wishlist w JOIN v_listing_details d ON d.listing_id = w.listing_id
     WHERE w.student_id = $1 ORDER BY w.created_at DESC`,
    [user.id]
  );
});

export const POST = handle(async (req) => {
  const user = await requireStudent();
  const { listingId } = await parseBody(req, listingRefSchema);
  await query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [user.id, listingId]);
  return NextResponse.json({ ok: true }, { status: 201 });
});

export const DELETE = handle(async (req) => {
  const user = await requireStudent();
  const listingId = parseId(searchParams(req).get("listingId"), "listingId");
  await query("DELETE FROM wishlist WHERE student_id = $1 AND listing_id = $2", [user.id, listingId]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
