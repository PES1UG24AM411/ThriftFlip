import { handle, HttpError, parseBody, parseId } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { offerActionSchema } from "@/lib/validation/schemas";

export const POST = handle(async (req, ctx) => {
  const user = await requireStudent();
  const id = parseId(ctx.params.id);
  const { action } = await parseBody(req, offerActionSchema);

  if (action === "accept") {
    const rows = await query("SELECT accept_offer($1::int, $2::int) AS tx", [id, user.id]);
    return { transactionId: rows[0].tx };
  }
  const sql =
    action === "reject"
      ? `UPDATE offer SET status = 'REJECTED', responded_at = now()
         WHERE offer_id = $1 AND status = 'PENDING'
           AND listing_id IN (SELECT listing_id FROM listing WHERE seller_id = $2) RETURNING offer_id`
      : `UPDATE offer SET status = 'WITHDRAWN', responded_at = now()
         WHERE offer_id = $1 AND status = 'PENDING' AND buyer_id = $2 RETURNING offer_id`;
  const rows = await query(sql, [id, user.id]);
  if (rows.length === 0) throw new HttpError(409, "Offer not found or already answered");
  return { ok: true };
});

export const dynamic = "force-dynamic";
