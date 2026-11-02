"use client";
import Link from "next/link";
import { useFetch, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Async, Empty, Help, Hint, ListingCard, PageTitle, SectionTitle, StatCard, Tip } from "@/components/ui";
import { Icon, IconName } from "@/components/icons";

const QUICK: { href: string; label: string; icon: IconName; tip: string }[] = [
  { href: "/marketplace", label: "Browse books", icon: "store", tip: "Search the marketplace by title, course, price or meaning." },
  { href: "/auctions", label: "Live auctions", icon: "gavel", tip: "Items being auctioned right now. Highest bid wins when time runs out." },
  { href: "/swaps", label: "Swap a book", icon: "swap", tip: "Offer a book you have and say which one you want in return." },
  { href: "/price-intelligence", label: "Check prices", icon: "tag", tip: "See the fair price of a book before you buy or sell." },
];

export default function Dashboard() {
  const profile = useLiveData("/api/profile"); // the counters (listings, open deals, unread) update by themselves
  const recs = useFetch("/api/recommendations");
  const p = profile.data;
  return (
    <div>
      <PageTitle
        subtitle="Here is what is happening with your listings, deals and messages."
        action={<Tip text="Create a listing for a book or item you want to sell or auction."><Link href="/listings/new" className="btn"><Icon name="plus" className="h-4 w-4" />New listing</Link></Tip>}
      >
        Hello{p ? `, ${p.me.name}` : ""}
      </PageTitle>

      <Hint id="dashboard-start" title="New here? Three quick steps">
        <ol className="list-decimal space-y-0.5 pl-5">
          <li>Your account is ready: there is no e-mail verification step.</li>
          <li>Use <b>Browse books</b> to find what you need, or <b>New listing</b> to sell something.</li>
          <li>Follow each deal under <b>Deals</b>. Hover over any button or badge to see what it does.</li>
        </ol>
      </Hint>

      <Async loading={profile.loading} error={profile.error}>
        {p && (
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            <StatCard label="Active listings" value={p.stats.active_listings} icon="store" href="/profile" tip="Items you are selling right now. Open your profile to see them." />
            <StatCard label="Open deals" value={p.stats.open_transactions} icon="list" href="/transactions" tip="Purchases and sales that are not finished yet. They may need an action from you." />
            <StatCard label="Favorites" value={p.stats.wishlist} icon="heart" href="/wishlist" tip="Listings you saved to look at later." />
            <StatCard label="Unread" value={p.stats.unread_notifications} icon="bell" href="/notifications" tip="Notifications you have not read yet: bids, offers, swaps and deal updates." />
            <StatCard label="My rating" value={p.ratingSummary?.rating_count ? `★ ${Number(p.ratingSummary.avg_rating).toFixed(1)}` : "Not rated yet"} icon="shield" href="/profile" tip="Your average star rating from finished deals." />
          </div>
        )}
      </Async>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK.map((q) => (
          <Tip key={q.href} text={q.tip} className="w-full">
            <Link href={q.href} className="card flex w-full items-center gap-3 !p-4">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brown text-cream"><Icon name={q.icon} /></span>
              <span className="font-semibold">{q.label}</span>
            </Link>
          </Tip>
        ))}
      </div>

      <SectionTitle hint="Picked for you using your favorites, your course, your recent searches and books you bought.">Recommended for you</SectionTitle>
      <Async loading={recs.loading} error={recs.error}>
        {!(recs.data ?? []).length ? (
          <Empty icon="spark" action={<Link href="/marketplace" className="btn-secondary">Browse the marketplace</Link>}>
            No recommendations yet. Add listings to your favorites or search for books and they will show up here.
          </Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(recs.data ?? []).slice(0, 6).map((r: any) => (
              <Link key={r.listing_id} href={`/listings/${r.listing_id}`} className="card">
                <p className="font-semibold">{r.title}</p>
                <p className="text-sm text-gray-600">{r.reason}</p>
                <p className="mt-2 font-serif text-xl font-bold">{money(r.price)}</p>
              </Link>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
