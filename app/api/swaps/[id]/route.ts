import { handle, parseBody, parseId } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { swapRespondSchema } from "@/lib/validation/schemas";
import { notifyAfterSwapChange } from "@/lib/notifyMatches";

export const POST = handle(async (req, ctx) => {
  const user = await requireStudent();
  const { accept } = await parseBody(req, swapRespondSchema);
  const rows = await query("SELECT respond_swap_request($1::int, $2::int, $3::boolean) AS result", [
    parseId(ctx.params.id), user.id, accept,
  ]);
  if (rows[0].result === "REJECTED") await notifyAfterSwapChange(); // the listings are free again and may fit another match
  return { result: rows[0].result }; // REJECTED | WAITING | READY
});

export const dynamic = "force-dynamic";
