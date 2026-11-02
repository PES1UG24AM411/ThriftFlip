import { NextResponse } from "next/server";
import { handle, HttpError, parseBody } from "@/lib/http";
import { withTransaction } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { ratingSchema } from "@/lib/validation/schemas";

// A trigger checks that the transaction is CONFIRMED/RELEASED and that rater/ratee are its two parties;
// UNIQUE(transaction_id, rater_id) prevents duplicate ratings.
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const b = await parseBody(req, ratingSchema);
  await withTransaction(async (c) => {
    const tx = (await c.query("SELECT buyer_id, seller_id FROM transactions WHERE transaction_id = $1", [b.transactionId])).rows[0];
    if (!tx) throw new HttpError(404, "Transaction not found");
    if (user.id !== tx.buyer_id && user.id !== tx.seller_id) throw new HttpError(403, "You are not part of this transaction");
    if ((await c.query("SELECT 1 FROM rating WHERE transaction_id = $1 AND rater_id = $2", [b.transactionId, user.id])).rowCount) {
      throw new HttpError(409, "You have already rated this deal");
    }
    const ratee = user.id === tx.buyer_id ? tx.seller_id : tx.buyer_id;
    const r = await c.query(
      "INSERT INTO rating (transaction_id, rater_id, ratee_id, score) VALUES ($1, $2, $3, $4) RETURNING rating_id",
      [b.transactionId, user.id, ratee, b.score]
    );
    if (b.review) await c.query("INSERT INTO review (rating_id, body) VALUES ($1, $2)", [r.rows[0].rating_id, b.review]);
  });
  return NextResponse.json({ ok: true }, { status: 201 });
});

export const dynamic = "force-dynamic";
