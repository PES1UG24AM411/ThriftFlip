import { NextResponse } from "next/server";
import { handle, parseBody, parseId, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { swapPreferenceSchema } from "@/lib/validation/schemas";
import { notifyAfterSwapChange } from "@/lib/notifyMatches";

export const POST = handle(async (req) => {
  const user = await requireStudent();
  const b = await parseBody(req, swapPreferenceSchema);
  const rows = await query(
    "INSERT INTO swap_preference (student_id, offered_listing_id, wanted_book_id) VALUES ($1, $2, $3) RETURNING preference_id",
    [user.id, b.offeredListingId, b.wantedBookId]
  );
  await notifyAfterSwapChange(); // a new wish can complete a direct or three-way match
  return NextResponse.json({ id: rows[0].preference_id }, { status: 201 });
});

export const DELETE = handle(async (req) => {
  const user = await requireStudent();
  await query("DELETE FROM swap_preference WHERE preference_id = $1 AND student_id = $2", [
    parseId(searchParams(req).get("id")), user.id,
  ]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
