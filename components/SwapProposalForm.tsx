"use client";
// "Propose a swap" panel on a listing page: choose one of MY active listings to offer, optionally add a
// settlement amount (money between the two students; THRIFTFLIP does not process payments) and a note.
import Link from "next/link";
import { useState } from "react";
import { apiFetch, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Alert, Help } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";

export default function SwapProposalForm({ listing, onDone }: { listing: { listing_id: number; title: string }; onDone: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const { data, error, loading } = useLiveData("/api/swaps/proposals"); // the owner's answer shows up by itself
  const [offered, setOffered] = useState("");
  const [amount, setAmount] = useState("");
  const [payer, setPayer] = useState("PROPOSER");
  const [message, setMessage] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const mine: any[] = data?.eligibleListings ?? [];
  const existing = (data?.proposals ?? []).find((p: any) => p.requested_listing_id === listing.listing_id && ["PENDING", "ACCEPTED"].includes(p.status) && p.myRole === "PROPOSER");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // ignore double clicks
    setErr("");
    const offeredTitle = mine.find((l) => String(l.listing_id) === offered)?.title ?? "your book";
    const settlement = Number(amount) || 0;
    const ok = await confirm({
      title: `Offer "${offeredTitle}" for "${listing.title}"?`,
      message: settlement > 0
        ? `You also agree that ${payer === "PROPOSER" ? "you pay" : "the owner pays"} ${money(settlement)} to the other student. THRIFTFLIP does not handle this money: you settle it in person.`
        : "The owner will be notified and can accept or reject. Nothing is final until you both confirm the exchange.",
      confirmLabel: "Send proposal",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await apiFetch("/api/swaps/proposals", {
        method: "POST",
        body: { offeredListingId: Number(offered), requestedListingId: listing.listing_id, settlementAmount: settlement, settlementPayer: settlement > 0 ? payer : undefined, message: message || undefined },
      });
      toast.success("Swap proposal sent. Follow it on the Swaps page.");
      onDone();
    } catch (ex) {
      setErr((ex as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="mt-5 text-sm text-gray-600">Loading swap options...</p>;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (existing) return <div className="mt-5"><Alert kind="info">You already proposed a swap for this book (status {existing.status}). <Link className="link" href="/swaps">Open Swaps</Link></Alert></div>;

  return (
    <form className="mt-5 space-y-3 rounded-xl border border-brown/20 p-3" onSubmit={submit}>
      <p className="flex items-center gap-1.5 text-sm font-bold">Propose a swap <Help text="Offer one of your own active books for this one. The owner can accept or reject. After you meet and exchange the books, both of you confirm in THRIFTFLIP." align="start" /></p>
      {mine.length === 0 ? (
        <p className="text-sm text-gray-600">You have no active fixed-price listing to offer. <Link className="link" href="/listings/new">List a book</Link> first.</p>
      ) : (
        <>
          <div>
            <label className="label" htmlFor="swap-offered">Book I offer</label>
            <select id="swap-offered" className="input" value={offered} onChange={(e) => setOffered(e.target.value)} required>
              <option value="">Choose one of my listings...</option>
              {mine.map((l) => <option key={l.listing_id} value={l.listing_id}>{l.title} ({money(l.price)})</option>)}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="swap-amount">Extra money (optional)</label>
              <input id="swap-amount" className="input" type="number" min="0" max="100000" step="1" placeholder="₹ 0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="swap-payer">Who pays it?</label>
              <select id="swap-payer" className="input" value={payer} onChange={(e) => setPayer(e.target.value)} disabled={!(Number(amount) > 0)}>
                <option value="PROPOSER">I pay</option>
                <option value="RECEIVER">The owner pays</option>
              </select>
            </div>
          </div>
          <p className="hint">The extra money is only an agreement between you two. THRIFTFLIP does not process payments.</p>
          <textarea className="input" rows={2} maxLength={500} placeholder="Note to the owner (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
          {err && <Alert kind="error">{err}</Alert>}
          <button className="btn" disabled={busy || !offered}>{busy ? "Sending..." : "Send swap proposal"}</button>
        </>
      )}
    </form>
  );
}
