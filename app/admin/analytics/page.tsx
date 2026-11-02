"use client";
import { useFetch, money } from "@/lib/client";
import { Async, Badge, PageTitle, SectionTitle, levelTone } from "@/components/ui";

function Table({ head, rows }: { head: string[]; rows: any[][] }) {
  return (
    <div className="card overflow-x-auto !p-0"><table className="w-full">
      <thead><tr>{head.map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="td">{c}</td>)}</tr>)}</tbody>
    </table></div>
  );
}

export default function AdminAnalytics() {
  const { data, error, loading } = useFetch("/api/admin/overview");
  const d = data;
  return (
    <div className="space-y-6">
      <PageTitle subtitle="Demand, prices, auctions, swaps and deals across the marketplace.">Analytics</PageTitle>
      <Async loading={loading} error={error}>
        {d && (
          <>
            <section><SectionTitle hint="Books many students want compared with the copies available.">High-demand books</SectionTitle>
              <Table head={["Book", "Edition", "Score", "Level"]} rows={d.demandBooks.map((b: any) => [b.title, b.edition, b.demand_score, <Badge key="l" tone={levelTone(b.demand_level)}>{b.demand_level}</Badge>])} /></section>
            <section><SectionTitle hint="Demand grouped by course.">Course demand</SectionTitle>
              <Table head={["Course", "Name", "Available", "Score", "Level"]} rows={d.demandCourses.map((c: any) => [c.code, c.name, c.available_listings, c.demand_score, <Badge key="l" tone={levelTone(c.demand_level)}>{c.demand_level}</Badge>])} /></section>
            <section><SectionTitle>Most wishlisted books</SectionTitle>
              <Table head={["Book", "Wishlists"]} rows={d.popularBooks.map((b: any) => [b.title, b.wishlisted])} /></section>
            <section><SectionTitle>Average sale price by subject</SectionTitle>
              <Table head={["Subject", "Sales", "Average"]} rows={d.avgPrices.map((p: any) => [p.subject, p.sales, money(p.avg_price)])} /></section>
            <div className="grid gap-5 md:grid-cols-3">
              <div className="card text-sm"><h3 className="font-sans text-base font-bold">Auctions</h3><p>Total {d.auctionStats.total} · active {d.auctionStats.active} · closed {d.auctionStats.closed}</p><p>{d.auctionStats.bids} bids · {d.auctionStats.anti_snipe_extensions} anti-sniping extensions</p></div>
              <div className="card text-sm"><h3 className="font-sans text-base font-bold">Swaps</h3><p>Proposals {d.swapStats.proposals} · pending {d.swapStats.pending} · accepted {d.swapStats.accepted} · declined {d.swapStats.declined}</p><p>Possible cycles right now: {d.swapStats.possible_cycles}</p></div>
              <div className="card text-sm"><h3 className="font-sans text-base font-bold">Waitlist</h3>{d.waitlistStats.map((w: any) => <p key={w.status}>{w.status}: {w.entries}</p>)}</div>
            </div>
            <section><SectionTitle hint="How many deals are at each step.">Transactions by state</SectionTitle>
              <Table head={["State", "Count"]} rows={d.txStats.map((t: any) => [t.state, t.transactions])} /></section>
          </>
        )}
      </Async>
    </div>
  );
}
