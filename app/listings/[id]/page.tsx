"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, dt, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Alert, Async, Badge, Help, ListingCard, ListingImage, PageTitle, RatingLine, SectionTitle, Tip } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useConfirm } from "@/components/feedback";
import SwapProposalForm from "@/components/SwapProposalForm";

export default function ListingDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  // Status, price and availability refresh by themselves. Only the first request counts as "the student viewed this
  // listing"; the background refreshes carry poll=1 so the server does not record a view every 2 seconds.
  const { data, error, loading, reload } = useLiveData(`/api/listings/${id}`, { pollQuery: "poll=1" });
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [offer, setOffer] = useState("");
  const [reportReason, setReportReason] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [photo, setPhoto] = useState(0);

  async function run(fn: () => Promise<any>, ok: string, after?: (r: any) => void) {
    setMsg(null);
    try {
      const r = await fn();
      setMsg({ kind: "success", text: ok });
      after ? after(r) : reload();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  const l = data?.listing;
  const fp = data?.fairPrice;
  const canBuy = l && !data.isOwner && l.status === "ACTIVE" && l.listing_type === "FIXED_PRICE";
  const canSwap = l && !data.isOwner && l.status === "ACTIVE" && l.listing_type === "FIXED_PRICE" && l.open_to_swap;

  return (
    <Async loading={loading} error={error}>
      {l && (
        <div>
          <PageTitle subtitle={l.author ? `${l.author} · Edition ${l.edition}` : undefined} action={<Link href="/marketplace" className="btn-secondary btn-sm">Back to marketplace</Link>}>{l.title}</PageTitle>
          <div className="grid gap-5 lg:grid-cols-3">
            <div className="card lg:col-span-2">
              {data.images.length > 0 ? (
                <div className="mb-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/images/${data.images[Math.min(photo, data.images.length - 1)].image_id}`} alt={l.title} className="max-h-96 w-full rounded-xl bg-gray-50 object-contain" />
                  {data.images.length > 1 && (
                    <div className="mt-2 flex gap-2">
                      {data.images.map((im: any, i: number) => (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={im.image_id} src={`/api/images/${im.image_id}`} alt="" onClick={() => setPhoto(i)} className={`h-16 w-16 cursor-pointer rounded-lg object-cover transition hover:opacity-90 ${i === photo ? "ring-2 ring-brown" : "opacity-80"}`} />
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="mb-3">
                  <ListingImage coverUrl={l.cover_url} isbn={l.isbn} alt={l.title} className="max-h-96 w-full rounded-xl bg-gray-50 object-contain"
                    placeholderClass="flex h-40 flex-col items-center justify-center gap-1 rounded-xl bg-gradient-to-br from-[#eadfa8] to-[#e3d399] text-sm text-gray-500" />
                </div>
              )}
              <div className="mb-2 flex flex-wrap gap-2">
                <Badge tone={l.listing_type === "AUCTION" ? "yellow" : "blue"} tip={l.listing_type === "AUCTION" ? "Auction: place a bid. The highest bid when the timer ends wins." : "Fixed price: you can buy it right away at this price."}>{l.listing_type === "AUCTION" ? "Auction" : "Fixed price"}</Badge>
                <Badge tip="Condition of the item, as described by the seller.">{String(l.item_condition).replace("_", " ")}</Badge>
                <Badge tone={l.status === "ACTIVE" ? "green" : "gray"} tip={l.status === "ACTIVE" ? "Available now." : "This item is not available to buy right now (for example it is reserved by another buyer)."}>{l.status}</Badge>
                {l.open_to_swap && <Badge tone="green" tip={'The owner would trade this for another book. Use "Propose a swap" below.'}>Open to swap</Badge>}
              </div>
              <p className="font-serif text-4xl font-bold">{money(l.current_price)}</p>
              {l.author && <p className="mt-2 text-sm">Subject: {l.subject}</p>}
              {l.isbn && <p className="text-sm text-gray-600">ISBN: {l.isbn}</p>}
              {l.course_code && <p className="text-sm text-gray-600">Course: {l.course_code} {l.course_name} · {l.department_name} · semester {l.course_semester}</p>}
              <p className="mt-3 whitespace-pre-wrap text-sm">{l.description || "No description."}</p>
              {l.open_to_swap && (
                <div className="mt-3 rounded-xl border border-green-700/30 bg-green-50 p-3 text-sm">
                  <p className="font-semibold">Wanted in a swap</p>
                  {data.wanted?.length ? (
                    <ul className="list-disc pl-5">{data.wanted.map((w: any) => <li key={w.wanted_id}>{w.title}{w.author ? ` (${w.author})` : ""}</li>)}</ul>
                  ) : <p className="text-gray-700">The seller did not list specific books. Any offer is welcome.</p>}
                </div>
              )}
              <div className="mt-4 flex items-center gap-3 rounded-xl border border-brown/20 bg-brown/5 p-3 text-sm">
                {data.seller?.profile_image_id ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/images/${data.seller.profile_image_id}`} alt="" className="h-12 w-12 rounded-full object-cover" />
                ) : <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brown font-serif text-lg text-cream">{l.seller_name?.[0]}</div>}
                <div>
                  <p>Seller: <Link className="link" href={`/profile/${l.seller_id}`}>{l.seller_name}</Link> · <RatingLine avg={data.seller?.avg_rating} count={data.seller?.rating_count} /> · {data.seller?.completed_transactions ?? 0} finished deals</p>
                  <p className="text-gray-600">{data.seller?.department} · semester {data.seller?.semester} · {l.wishlist_count} favorited</p>
                  <p className="text-gray-600">Contact: {data.seller?.contact ? `${String(data.seller.contact_preference).toLowerCase()}: ${data.seller.contact}` : "through THRIFTFLIP messages"}</p>
                </div>
              </div>
              {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

              {!data.isOwner && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {canBuy && <Tip text="Starts a deal at the listed price. THRIFTFLIP does not process payments: you and the seller arrange payment and hand-over yourselves and tick off each step on the Deals page."><button className="btn" onClick={async () => { if (await confirm({ title: `Buy "${l.title}" for ${money(l.current_price)}?`, message: "This reserves the book and starts a deal with the seller. No money moves through THRIFTFLIP: you arrange payment and hand-over with the seller and follow the steps on the Deals page.", confirmLabel: "Yes, reserve it" })) run(() => apiFetch("/api/transactions", { method: "POST", body: { listingId: l.listing_id } }), "Purchase started", (r) => router.push(`/transactions/${r.transactionId}`)); }}>Buy now</button></Tip>}
                  {l.listing_type === "AUCTION" && l.auction_id && <Tip text="See the live timer and bid history, and place a bid."><Link className="btn" href={`/auctions/${l.auction_id}`}>Open auction / bid</Link></Tip>}
                  <Tip text={data.inWishlist ? "Remove this listing from your favorites." : "Save this listing to your favorites to find it again later."}><button className="btn-secondary" onClick={() => run(() => data.inWishlist ? apiFetch(`/api/wishlist?listingId=${l.listing_id}`, { method: "DELETE" }) : apiFetch("/api/wishlist", { method: "POST", body: { listingId: l.listing_id } }), data.inWishlist ? "Removed from favorites" : "Added to favorites")}><Icon name="heart" className="h-4 w-4" />{data.inWishlist ? "Remove from favorites" : "Add to favorites"}</button></Tip>
                  <Tip text="Ask the seller a question before you buy. Opens a private chat."><button className="btn-secondary" onClick={() => run(() => apiFetch("/api/conversations", { method: "POST", body: { listingId: l.listing_id } }), "Conversation opened", (r) => router.push(`/messages?c=${r.id}`))}><Icon name="chat" className="h-4 w-4" />Message seller</button></Tip>
                </div>
              )}
              {canSwap && <SwapProposalForm listing={l} onDone={reload} />}

              {canBuy && (
                <form className="mt-5 rounded-xl border border-brown/20 p-3" onSubmit={async (e) => { e.preventDefault(); if (await confirm({ title: `Send an offer of ${money(Number(offer))}?`, message: "The seller can accept, reject, or ignore it. You can withdraw it later.", confirmLabel: "Send offer" })) run(() => apiFetch("/api/offers", { method: "POST", body: { listingId: l.listing_id, amount: Number(offer) } }), "Offer sent"); }}>
                  <label className="label flex items-center gap-1.5" htmlFor="offer">Make an offer <Help text="Think the price is too high? Suggest a lower price. The seller decides whether to accept." align="start" /></label>
                  <div className="flex gap-2">
                    <input id="offer" className="input max-w-[180px]" type="number" min="1" placeholder="Your offer (₹)" value={offer} onChange={(e) => setOffer(e.target.value)} required />
                    <button className="btn-secondary">Send offer</button>
                  </div>
                </form>
              )}
              {data.isOwner && (
                <div className="mt-5 flex flex-wrap gap-2">
                  <Tip text="Change the title, description, photos or price."><Link className="btn-secondary" href={`/listings/${l.listing_id}/edit`}>Edit</Link></Tip>
                  {l.status === "ACTIVE" && l.listing_type === "FIXED_PRICE" && (
                    <Tip text="Marks the item as sold and removes it from the marketplace."><button className="btn" onClick={async () => { if (await confirm({ title: "Mark this book as sold?", message: "It will be removed from the marketplace.", confirmLabel: "Mark as sold" })) run(() => apiFetch(`/api/listings/${l.listing_id}/sold`, { method: "POST", body: {} }), "Marked as sold"); }}>Mark as sold</button></Tip>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-5">
              {fp && fp.estimated_price && (
                <div className="card">
                  <h3 className="flex items-center gap-1.5 font-sans font-bold">Price intelligence <Help text="A fair price estimate from similar books that really sold on THRIFTFLIP." /></h3>
                  <p className="text-sm">Estimated fair price: <b>{money(fp.estimated_price)}</b></p>
                  <p className="hint">History ({fp.sample_size} sales): min {money(fp.historical_min)}, avg {money(fp.historical_avg)}, max {money(fp.historical_max)}</p>
                  <p className="mt-1 text-sm">
                    {Number(l.price) > Number(fp.estimated_price) * 1.15 ? "Asking price is above the estimate." : Number(l.price) < Number(fp.estimated_price) * 0.85 ? "Asking price is below the estimate: good deal." : "Asking price is close to the estimate."}
                  </p>
                </div>
              )}
              {!data.isOwner && (
                <div className="card">
                  <h3 className="mb-1 flex items-center gap-1.5 font-sans font-bold">Report this listing <Help text="Use this for fake listings, wrong descriptions, scams or spam. Admins review reports." /></h3>
                  <select className="input mb-2" value={reportReason} onChange={(e) => setReportReason(e.target.value)}>
                    <option value="">Reason...</option>
                    {["FAKE_LISTING", "WRONG_DESCRIPTION", "SCAM", "SPAM", "SUSPICIOUS_BEHAVIOR"].map((r) => <option key={r} value={r}>{r.replace("_", " ")}</option>)}
                  </select>
                  <textarea className="input mb-2" rows={2} placeholder="Details (optional)" value={reportDetails} onChange={(e) => setReportDetails(e.target.value)} />
                  <button className="btn-secondary" disabled={!reportReason} onClick={async () => { if (await confirm({ title: "Send this report to the admins?", message: "Please only report real problems, such as a fake listing, a wrong description, a scam or spam.", confirmLabel: "Send report", tone: "danger" })) run(() => apiFetch("/api/reports", { method: "POST", body: { listingId: l.listing_id, reason: reportReason, details: reportDetails || undefined } }), "Report sent to the admins", () => { setReportReason(""); setReportDetails(""); }); }}>Send report</button>
                </div>
              )}
            </div>
          </div>

          <SectionTitle hint="Found automatically by comparing the meaning of listing titles and descriptions (vector similarity).">Similar listings</SectionTitle>
          {data.similar.length === 0 ? <p className="text-sm text-gray-500">No similar listings yet (embeddings may still be generating).</p> : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{data.similar.map((s: any) => <ListingCard key={s.listing_id} l={s} />)}</div>
          )}
        </div>
      )}
    </Async>
  );
}
