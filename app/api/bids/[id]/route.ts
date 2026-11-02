import { handle, parseId } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";

export const DELETE = handle(async (_req, ctx) => {
  const user = await requireStudent();
  await query("SELECT cancel_bid($1::int, $2::int)", [parseId(ctx.params.id), user.id]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
