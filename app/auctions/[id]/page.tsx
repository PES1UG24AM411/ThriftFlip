"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, dt, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Alert, Async, Badge, Help, Hint, PageTitle, Tip } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useConfirm } from "@/components/feedback";

export default function AuctionPage() {
  const { id } = useParams<{ id: string }>();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useLiveData(`/api/auctions/${id}`); // bids and the end of the auction refresh every 2 seconds
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState<{ kind: "error" | "success" | "info"; text: string } | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000); // the countdown
    return () => clearInterval(t);
  }, []);

  const a = data?.auction;
  const left = a ? Math.max(0, Math.floor((new Date(a.end_time).getTime() - now) / 1000)) : 0;
  const open = a && a.status === "ACTIVE" && left > 0;

  async function bid(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (!(await confirm({ title: `Place a bid of ${money(Number(amount))}?`, message: "A bid is a commitment: if yours is the highest when the timer ends, you win the item. Bids lower than the current price can be cancelled before the end; the highest bid cannot.", confirmLabel: "Place bid" }))) return;
    try {
      const r = await apiFetch("/api/bids", { method: "POST", body: { auctionId: Number(id), amount: Number(amount) } });
      setMsg(r.extended ? { kind: "info", text: "Bid accepted. It arrived in the last minute, so the auction was extended by 2 minutes (anti-sniping)." } : { kind: "success", text: "Bid accepted." });
      setAmount("");
      reload();
    } catch (err) { setMsg({ kind: "error", text: (err as Error).message }); }
  }
  async function cancel(bidId: number) {
    if (!(await confirm({ title: "Cancel this bid?", message: "Your bid will be removed from the auction.", confirmLabel: "Cancel bid", cancelLabel: "Keep bid", tone: "danger" }))) return;
    try { await apiFetch(`/api/bids/${bidId}`, { method: "DELETE" }); reload(); } catch (err) { setMsg({ kind: "error", text: (err as Error).message }); }
  }

  return (
    <Async loading={loading && !data} error={error}>
      {a && (
        <div>
          <PageTitle action={<Link href="/auctions" className="btn-secondary btn-sm">All auctions</Link>}>{a.title}</PageTitle>
          <Hint id="auction-detail" title="How to bid" icon="gavel">Enter an amount at or above the minimum next bid. If you bid in the last minute, the auction is extended by 2 minutes (anti-sniping), so other bidders can respond. This page refreshes by itself.</Hint>
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="card lg:col-span-1">
              <Badge tone={a.status === "ACTIVE" ? "green" : "gray"}>{a.status}</Badge>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-gray-600">Current price</p>
              <p className="font-serif text-4xl font-bold">{money(a.current_price)}</p>
              <p className="mt-3 text-sm">Highest bidder: {a.highest_bidder_name ?? "none yet"}</p>
              <p className="text-sm">Ends: {dt(a.end_time)}{a.extension_count ? ` (extended ${a.extension_count}x)` : ""}</p>
              <p className={`mt-2 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold ${open ? "bg-brown text-cream" : "bg-brown/10 text-brown"}`}><Icon name="clock" className="h-4 w-4" />{open ? `Time left: ${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m ${left % 60}s` : "Auction ended"}</p>
              <p className="hint">Minimum next bid: {money(data.minNextBid)} · increment {money(a.min_increment)}</p>
              <Link className="link mt-2 inline-block text-sm" href={`/listings/${a.listing_id}`}>View listing</Link>
              {a.status === "CLOSED" && a.winner_id && <Alert kind="success">Auction ended. Winner: {a.highest_bidder_name} with the highest bid of {money(a.current_price)}. {data.isSeller ? "Follow the sale on the Deals page." : "The winner and the seller follow the payment steps on the Deals page."}</Alert>}
              {a.status === "CLOSED" && !a.winner_id && <Alert kind="info">Auction ended without any valid bid, so the listing was closed.</Alert>}
              {open && !data.isSeller && (
                <form onSubmit={bid} className="mt-4 space-y-2 border-t border-brown/15 pt-4">
                  <label className="label flex items-center gap-1.5" htmlFor="bid">Your bid (₹) <Help text="Must be at least the minimum next bid shown above." align="start" /></label>
                  <input id="bid" className="input" type="number" min={data.minNextBid} step="0.01" placeholder={`At least ${data.minNextBid}`} value={amount} onChange={(e) => setAmount(e.target.value)} required />
                  <Tip text="You will be asked to confirm before the bid is placed." className="w-full"><button className="btn w-full">Place bid</button></Tip>
                </form>
              )}
              {data.isSeller && <p className="hint mt-3">You are the seller: you can see all bidders.</p>}
              {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
            </div>
            <div className="card overflow-x-auto lg:col-span-2">
              <h3 className="mb-3 font-sans text-base font-bold">Bid history ({data.bids.length})</h3>
              {data.bids.length === 0 && <p className="text-sm text-gray-600">No bids yet. Be the first to bid.</p>}
              <table className="w-full">
                <thead><tr><th className="th">Bidder</th><th className="th">Amount</th><th className="th">Time</th><th className="th"></th></tr></thead>
                <tbody>
                  {data.bids.map((b: any) => (
                    <tr key={b.bid_id}>
                      <td className="td">{b.bidder}{b.isMine ? " (you)" : ""}{b.status === "CANCELLED" ? " · cancelled" : ""}</td>
                      <td className="td">{money(b.amount)}</td>
                      <td className="td">{dt(b.placed_at)}{b.seconds_before_end !== null ? ` (${Number(b.seconds_before_end).toFixed(0)}s before end)` : ""}</td>
                      <td className="td">{b.isMine && b.status === "VALID" && open && Number(b.amount) < Number(a.current_price) && <Tip text="Withdraw this bid. Only possible while it is not the highest bid."><button className="btn-secondary btn-sm" onClick={() => cancel(b.bid_id)}>Cancel</button></Tip>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Async>
  );
}
