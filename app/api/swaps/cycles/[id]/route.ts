// Confirm or call off a circular swap (3 or more students). The database functions check that the student takes part,
// that everybody accepted before anyone confirms, and complete the swap only when ALL participants have confirmed.
import { handle, HttpError, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { z } from "zod";
import { notifyAfterSwapChange } from "@/lib/notifyMatches";

const cycleActionSchema = z.object({ action: z.enum(["confirm", "cancel"]) });

export const POST = handle(async (req, ctx) => {
  const user = await requireStudent();
  const { action } = await parseBody(req, cycleActionSchema);
  const cycleId = ctx.params.id;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cycleId)) throw new HttpError(400, "Invalid swap id");
  if (action === "cancel") {
    await query("SELECT cancel_swap_cycle($1::uuid, $2::int)", [cycleId, user.id]);
    await notifyAfterSwapChange(); // the listings are free again
    return { result: "CANCELLED" };
  }
  const rows = await query("SELECT confirm_swap_cycle($1::uuid, $2::int) AS result", [cycleId, user.id]);
  return { result: rows[0].result }; // WAITING | COMPLETED
});

export const dynamic = "force-dynamic";
