"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch, dt, money, useFetch } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Alert, Async, Badge, Empty, Help, Hint, PageTitle, SectionTitle, Tip, levelTone } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";

export default function PriceIntelligence() {
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [books, setBooks] = useState<any[]>([]);
  const [bookId, setBookId] = useState("");
  const [condition, setCondition] = useState("GOOD");
  const [maxPrice, setMaxPrice] = useState("");
  const [alertCondition, setAlertCondition] = useState(""); // "" = any condition
  const [msg, setMsg] = useState("");
  const result = useFetch(bookId ? `/api/price-intelligence?bookId=${bookId}&condition=${condition}` : null);
  const alerts = useLiveData("/api/price-alerts"); // the "match now" list follows new and cheaper listings by itself
  const demand = useFetch("/api/demand");

  useEffect(() => { apiFetch(`/api/books?q=${encodeURIComponent(q)}`).then(setBooks).catch(() => {}); }, [q]);

  const fp = result.data?.fairPrice;
  const cur = result.data?.currentListings;
  return (
    <div className="space-y-6">
      <PageTitle subtitle="Check what a book is really worth, see how much students want it, and get notified when it is cheap enough.">Price intelligence</PageTitle>
      <Hint id="prices-how" title="How to use this page" icon="tag">Search for a book, pick it from the list and choose its condition. You will see a fair price, past sales and current listings. Then set a <b>price alert</b> to be notified when the book is listed at or below your price.</Hint>
      <div className="card grid gap-3 md:grid-cols-3">
        <input aria-label="Search books" className="input" placeholder="Search books" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Book" className="input" value={bookId} onChange={(e) => setBookId(e.target.value)}><option value="">Select a book...</option>{books.map((b) => <option key={b.id} value={b.id}>{b.title} (ed. {b.edition})</option>)}</select>
        <select aria-label="Condition" className="input" value={condition} onChange={(e) => setCondition(e.target.value)}>{["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"].map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select>
      </div>
      {bookId && (
        <Async loading={result.loading} error={result.error}>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="card"><p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-600">Estimated fair price <Help text="What this book should cost, estimated from similar sales. Closer matches (same title, edition, condition, course) count more." align="start" /></p><p className="font-serif text-4xl font-bold">{fp?.estimated_price ? money(fp.estimated_price) : "no history"}</p>
              <p className="hint">Weights: 30% same title, 25% same edition, 25% same condition and subject, 20% same course</p></div>
            <div className="card text-sm"><p className="font-sans font-bold">Historical sales ({fp?.sample_size ?? 0})</p><p>Min {money(fp?.historical_min)} · Avg {money(fp?.historical_avg)} · Max {money(fp?.historical_max)}</p></div>
            <div className="card text-sm"><p className="font-sans font-bold">Current listings ({cur?.active_listings ?? 0})</p><p>Min {money(cur?.min_price)} · Avg {money(cur?.avg_price)} · Max {money(cur?.max_price)}</p>
              {result.data?.demand && <p className="mt-2">Demand: <Badge tone={levelTone(result.data.demand.demand_level)} tip="How many students want this book compared with how many copies are available.">{result.data.demand.demand_level}</Badge></p>}</div>
          </div>
          <form className="card mt-4 flex flex-wrap items-center gap-2" onSubmit={async (e) => { e.preventDefault(); setMsg(""); try { await apiFetch("/api/price-alerts", { method: "POST", body: { bookId: Number(bookId), maxPrice: Number(maxPrice), condition: alertCondition || undefined } }); setMaxPrice(""); toast.success("Price alert created"); alerts.reload(); } catch (err) { setMsg((err as Error).message); } }}>
            <span className="text-sm">Notify me when this book is listed at or below</span>
            <input aria-label="Maximum price" className="input max-w-[140px]" type="number" min="1" placeholder="₹" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} required />
            <select aria-label="Alert condition" className="input max-w-[200px]" value={alertCondition} onChange={(e) => setAlertCondition(e.target.value)}>
              <option value="">Any condition</option>
              {["NEW", "LIKE_NEW", "GOOD", "FAIR"].map((c) => <option key={c} value={c}>{c === "NEW" ? "New only" : `${c.replace("_", " ").toLowerCase()} or better`}</option>)}
            </select>
            <Tip text="You get a notification when this book is listed at or below your price, in the condition you chose. A listing is only announced once per price."><button className="btn">Create alert</button></Tip>
          </form>
          {msg && <Alert>{msg}</Alert>}
        </Async>
      )}

      <section>
        <SectionTitle hint="Alerts you created. Each one lists the books that are at or below your price right now, and you get a notification for every new listing that is cheap enough.">My price alerts</SectionTitle>
        <Async loading={alerts.loading} error={alerts.error}>
          {!alerts.data?.length ? <Empty icon="bell">No alerts yet. Pick a book above and create one.</Empty> : alerts.data.map((a: any) => (
            <div key={a.alert_id} className="card mb-3 space-y-2 !p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><b>{a.title}</b> at or below {money(a.max_price)}{a.min_condition ? ` · ${a.min_condition === "NEW" ? "new only" : `${String(a.min_condition).replace("_", " ").toLowerCase()} or better`}` : ""} <Badge tone={a.matches.length ? "green" : "yellow"}>{a.matches.length ? `${a.matches.length} listing${a.matches.length > 1 ? "s" : ""} match now` : "watching"}</Badge></span>
                <button className="btn-secondary btn-sm" onClick={async () => { if (!(await confirm({ title: "Delete this price alert?", confirmLabel: "Delete alert", tone: "danger" }))) return; await apiFetch(`/api/price-alerts?id=${a.alert_id}`, { method: "DELETE" }); toast.success("Price alert deleted"); alerts.reload(); }}>Delete</button>
              </div>
              {a.matches.map((m: any) => (
                <p key={m.listing_id} className="flex flex-wrap items-center gap-2">
                  <Link className="link" href={`/listings/${m.listing_id}`}>{m.title}</Link> · {money(m.price)} · {String(m.condition).replace("_", " ").toLowerCase()}
                  <Tip text={m.match_percent === 100 ? "This is the same book as your alert." : "The title is written differently, so this is how sure we are that it is the same book. Open the listing to check."}><Badge tone={m.match_percent === 100 ? "green" : "yellow"}>{m.match_percent === 100 ? "exact match" : `${m.match_percent}% match`}</Badge></Tip>
                  <button className="btn-secondary btn-sm" onClick={async () => { try { const r = await apiFetch("/api/conversations", { method: "POST", body: { listingId: m.listing_id } }); router.push(`/messages?c=${r.id}`); } catch (e: any) { toast.error(e.message ?? "Could not open the chat"); } }}>Message {m.seller_name}</button>
                </p>
              ))}
            </div>
          ))}
        </Async>
      </section>

      <section>
        <SectionTitle hint="How much interest each book gets: wishlists, searches, bids and swap requests compared with the copies available.">Demand right now</SectionTitle>
        <Async loading={demand.loading} error={demand.error}>
          <div className="card overflow-x-auto !p-0"><table className="w-full">
            <thead><tr><th className="th">Book</th><th className="th">Wishlists</th><th className="th">Searches (30d)</th><th className="th">Bids</th><th className="th">Swap requests</th><th className="th">Available</th><th className="th">Demand</th></tr></thead>
            <tbody>{(demand.data?.books ?? []).map((b: any) => (
              <tr key={b.book_id}><td className="td">{b.title}</td><td className="td">{b.wishlist_count}</td><td className="td">{b.search_count_30d}</td><td className="td">{b.bid_count}</td><td className="td">{b.swap_request_count}</td><td className="td">{b.available_listings}</td><td className="td"><Badge tone={levelTone(b.demand_level)}>{b.demand_level}</Badge></td></tr>))}</tbody>
          </table></div>
        </Async>
      </section>
    </div>
  );
}
