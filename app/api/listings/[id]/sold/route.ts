import { handle, parseId } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";

// Seller marks the book as sold: it disappears from the active marketplace (function mark_listing_sold).
export const POST = handle(async (_req, ctx) => {
  const user = await requireStudent();
  await query("SELECT mark_listing_sold($1::int, $2::int)", [parseId(ctx.params.id), user.id]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
