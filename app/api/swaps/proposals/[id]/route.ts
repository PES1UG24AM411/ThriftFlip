import { handle, HttpError, parseBody, parseId } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { swapProposalActionSchema } from "@/lib/validation/schemas";
import { notifyAfterSwapChange } from "@/lib/notifyMatches";

// accept / reject / cancel / confirm. Who may do what, and in which status, is enforced inside the database
// functions (row locks make repeated or simultaneous clicks safe); their messages are shown to the student.
export const POST = handle(async (req, ctx) => {
  const user = await requireStudent();
  const id = parseId(ctx.params.id);
  const { action } = await parseBody(req, swapProposalActionSchema);
  if (action === "confirm") {
    const rows = await query("SELECT confirm_swap_exchange($1::int, $2::int) AS result", [id, user.id]);
    return { result: rows[0].result }; // WAITING | COMPLETED
  }
  const rows = await query("SELECT respond_swap_proposal($1::int, $2::int, $3::text) AS result", [id, user.id, action]);
  if (!rows[0]) throw new HttpError(500, "Swap action failed");
  if (rows[0].result === "REJECTED" || rows[0].result === "CANCELLED") await notifyAfterSwapChange(); // the listings are free again
  return { result: rows[0].result }; // ACCEPTED | REJECTED | CANCELLED
});

export const dynamic = "force-dynamic";
