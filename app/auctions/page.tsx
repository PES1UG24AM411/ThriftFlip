"use client";
import Link from "next/link";
import { dt, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Async, Empty, Hint, PageTitle } from "@/components/ui";

export default function Auctions() {
  const { data, error, loading } = useLiveData("/api/auctions"); // prices, bid counts and ended auctions update by themselves
  return (
    <div>
      <PageTitle subtitle="Items sold to the highest bidder. Open an auction to see the countdown and place a bid.">Live auctions</PageTitle>
      <Hint id="auctions-how" title="How auctions work" icon="gavel">
        Each new bid must beat the current price by the minimum increment. If a bid arrives in the last minute, the timer is extended, so there is always time to answer.
      </Hint>
      <Async loading={loading} error={error}>
        {!data?.length ? <Empty icon="gavel" action={<Link href="/listings/new" className="btn">Start an auction</Link>}>No active auctions right now. Check back soon, or list an item as an auction yourself.</Empty> : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((a: any) => (
              <Link key={a.auction_id} href={`/auctions/${a.auction_id}`} className="card">
                <h3 className="font-sans text-base font-bold leading-snug">{a.title}</h3>
                <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-600">Current price</p>
                <p className="font-serif text-3xl font-bold">{money(a.current_price)}</p>
                <p className="mt-2 text-xs text-gray-600">{a.bid_count} bids · ends {dt(a.end_time)}{a.extension_count ? ` (extended ${a.extension_count}x)` : ""}</p>
                <p className="text-xs text-gray-600">{a.seller_name} · {a.campus_name}</p>
              </Link>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
