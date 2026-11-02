import { handle, HttpError, parseBody, parseId } from "@/lib/http";
import { query, queryOne } from "@/lib/db/pool";
import { requireUser } from "@/lib/auth/session";
import { transitionSchema } from "@/lib/validation/schemas";
import { actionsFor, TxActor, WHO_CAN_MOVE_TO } from "@/lib/transactions";

async function loadTx(id: number) {
  return queryOne(
    `SELECT t.*, l.title, bu.name AS buyer_name, se.name AS seller_name,
            lo.title AS swapped_for_title, sp.settlement_amount, sp.settlement_payer
     FROM transactions t
     JOIN listing l ON l.listing_id = t.listing_id
     LEFT JOIN swap_proposal sp ON sp.swap_proposal_id = t.swap_proposal_id
     LEFT JOIN listing lo ON lo.listing_id = sp.offered_listing_id
     JOIN student bu ON bu.student_id = t.buyer_id
     JOIN student se ON se.student_id = t.seller_id
     WHERE t.transaction_id = $1`,
    [id]
  );
}

function actorOf(tx: { buyer_id: number; seller_id: number }, user: { id: number; role: string }): TxActor {
  if (user.role === "ADMIN") return "admin";
  if (tx.buyer_id === user.id) return "buyer";
  if (tx.seller_id === user.id) return "seller";
  throw new HttpError(403, "You are not part of this transaction");
}

export const GET = handle(async (_req, ctx) => {
  const user = await requireUser();
  const tx = await loadTx(parseId(ctx.params.id));
  if (!tx) throw new HttpError(404, "Transaction not found");
  const actor = actorOf(tx, user);

  const history = await query(
    `SELECT history_id, previous_state, new_state, changed_by_type, changed_by_id, changed_at
     FROM transaction_state_history WHERE transaction_id = $1 ORDER BY changed_at, history_id`,
    [tx.transaction_id]
  );
  const alreadyRated = user.role === "STUDENT"
    ? !!(await queryOne("SELECT 1 FROM rating WHERE transaction_id = $1 AND rater_id = $2", [tx.transaction_id, user.id]))
    : true;
  return {
    transaction: tx,
    history,
    myRole: actor,
    actions: actionsFor(tx.state, actor),
    canRate: !alreadyRated && actor !== "admin" && tx.state === "RELEASED", // only a FINISHED deal can be rated
  };
});

// The API checks WHO may ask for a state; the database trigger checks the MOVE is valid.
export const POST = handle(async (req, ctx) => {
  const user = await requireUser();
  const { state } = await parseBody(req, transitionSchema);
  const tx = await loadTx(parseId(ctx.params.id));
  if (!tx) throw new HttpError(404, "Transaction not found");
  const actor = actorOf(tx, user);
  if (!WHO_CAN_MOVE_TO[state].includes(actor)) throw new HttpError(403, `A ${actor} cannot move a transaction to ${state}`);

  await query("SELECT transition_transaction($1::int, $2::text, $3::text, $4::int)", [
    tx.transaction_id, state, user.role === "ADMIN" ? "ADMIN" : "STUDENT", user.id,
  ]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
