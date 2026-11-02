"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { apiFetch, dt, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Alert, Async, Badge, Help, Hint, PageTitle, Stepper, Tip } from "@/components/ui";
import { STATE_TIPS } from "@/lib/ui-text";
import { useConfirm } from "@/components/feedback";

const LABEL: Record<string, string> = {
  PAYMENT_HELD: "Payment agreed", HANDED_OFF: "Mark item handed over", CONFIRMED: "Confirm I received it",
  RELEASED: "Mark deal complete", CANCELLED: "Cancel deal",
};
const STEPS = ["PENDING", "PAYMENT_HELD", "HANDED_OFF", "CONFIRMED", "RELEASED"];
const STEP_LABEL: Record<string, string> = { PENDING: "Started", PAYMENT_HELD: "Payment agreed", HANDED_OFF: "Handed over", CONFIRMED: "Confirmed", RELEASED: "Complete" };
const ACTION_TIP: Record<string, string> = {
  PAYMENT_HELD: "Tell the seller you have agreed how and when you will pay. THRIFTFLIP does not hold or move any money: you pay the seller directly.",
  HANDED_OFF: "Tell the buyer the item has been handed over.",
  CONFIRMED: "Confirm that you received the item and it matches the listing.",
  RELEASED: "The seller confirms the deal is finished (item handed over and the agreed payment received). This completes the deal, and only completed deals can be rated.",
  CANCELLED: "Stop this deal. Use it if the deal falls through.",
};

export default function TransactionPage() {
  const { id } = useParams<{ id: string }>();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLiveData(`/api/transactions/${id}`); // the other student's steps show up by themselves
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [score, setScore] = useState("5");
  const [review, setReview] = useState("");

  async function run(fn: () => Promise<any>, ok: string) {
    setMsg(null);
    try { await fn(); setMsg({ kind: "success", text: ok }); reload(); } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); }
  }
  const t = data?.transaction;

  return (
    <Async loading={loading} error={error}>
      {t && (
        <div>
          <PageTitle subtitle="Follow the steps below. The buttons show only what you can do right now." action={<Link href="/transactions" className="btn-secondary btn-sm">All deals</Link>}>{t.title}</PageTitle>
          <div className="grid gap-5 md:grid-cols-2">
            <div className="card">
              <p className="text-sm">Buyer: <b>{t.buyer_name}</b> · Seller: <b>{t.seller_name}</b></p>
              <p className="text-sm">Type: {t.transaction_type.replace("_", " ")} · Amount: {t.transaction_type === "SWAP" ? (Number(t.amount) > 0 ? `swap + ${money(t.amount)} agreed between the students` : "plain swap") : money(t.amount)}</p>
              {t.swapped_for_title && <p className="text-sm">Swap: <b>{t.swapped_for_title}</b> (from {t.buyer_name}) ⇄ <b>{t.title}</b> (from {t.seller_name})</p>}
              <Stepper steps={STEPS.map((s) => ({ key: s, label: STEP_LABEL[s], tip: STATE_TIPS[s] }))} current={t.state} cancelled={t.state === "CANCELLED"} />
              {t.state === "CANCELLED" && <Badge tone="red" tip={STATE_TIPS.CANCELLED}>CANCELLED</Badge>}
              <p className="mt-2 hint">THRIFTFLIP does not process payments. It records the steps you and the other student agree on.</p>
              <p className="mb-2 mt-3 flex items-center gap-1.5 text-sm font-semibold">Your next step <Help text="These are the actions you are allowed to take at this point in the deal." align="start" /></p>
              <div className="flex flex-wrap gap-2">
                {data.actions.map((s: string) => (
                  <Tip key={s} text={ACTION_TIP[s] ?? LABEL[s]}><button className={s === "CANCELLED" ? "btn-danger" : "btn"} onClick={async () => { if (await confirm({ title: `${LABEL[s]}?`, message: ACTION_TIP[s], confirmLabel: LABEL[s], tone: s === "CANCELLED" ? "danger" : "default" })) run(() => apiFetch(`/api/transactions/${id}`, { method: "POST", body: { state: s } }), `Moved to ${s}`); }}>{LABEL[s]}</button></Tip>
                ))}
                {data.actions.length === 0 && <p className="text-sm text-gray-500">No action available for you right now.</p>}
              </div>
              {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            </div>
            <div className="card">
              <h3 className="mb-2 font-sans text-base font-bold">State history</h3>
              <ul className="space-y-2 text-sm">
                {data.history.map((h: any) => (
                  <li key={h.history_id}>{h.previous_state ?? "created"} → <b>{h.new_state}</b> <span className="text-gray-500">by {h.changed_by_type}{h.changed_by_id ? ` #${h.changed_by_id}` : ""} · {dt(h.changed_at)}</span></li>
                ))}
              </ul>
            </div>
          </div>
          {data.canRate && (
            <form className="card mt-5 max-w-md space-y-3" onSubmit={(e) => { e.preventDefault(); run(() => apiFetch("/api/ratings", { method: "POST", body: { transactionId: Number(id), score: Number(score), review: review || undefined } }), "Thanks for rating!"); }}>
              <h3 className="flex items-center gap-1.5 font-sans text-base font-bold">Rate this deal <Help text="Your rating helps other students trust good sellers and buyers." align="start" /></h3>
              <select className="input" value={score} onChange={(e) => setScore(e.target.value)}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} star{n > 1 ? "s" : ""}</option>)}</select>
              <textarea className="input" rows={2} placeholder="Review (optional)" value={review} onChange={(e) => setReview(e.target.value)} />
              <button className="btn">Submit rating</button>
            </form>
          )}
        </div>
      )}
    </Async>
  );
}
