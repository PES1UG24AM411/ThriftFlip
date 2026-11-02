"use client";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, useFetch } from "@/lib/client";
import { Alert, Async, Badge, Empty, PageTitle, SectionTitle, StatCard, Tip, levelTone } from "@/components/ui";
import { useConfirm } from "@/components/feedback";

export default function AdminHome() {
  const confirm = useConfirm();
  const { data, error, loading, reload } = useFetch("/api/admin/overview");
  const [msg, setMsg] = useState("");
  const o = data?.overview;
  const cards: Array<[string, any, import("@/components/icons").IconName, string]> = o ? [
    ["Students", o.total_students, "user", "Registered student accounts."], ["Suspended", o.suspended_students, "shield", "Students suspended after a report."], ["Active listings", o.active_listings, "store", "Items currently for sale."],
    ["Active auctions", o.active_auctions, "gavel", "Auctions that are still running."], ["Completed deals", o.completed_transactions, "check", "Deals that finished successfully."], ["Open deals", o.open_transactions, "list", "Deals still in progress."],
    ["Pending reports", o.pending_reports, "flag", "Reports nobody has started reviewing yet. See the Reports page."], ["Unread replies", o.unread_replies, "chat", "Replies from students to admin messages."], ["Flagged bidder pairs", o.flagged_bidder_pairs, "alert", "Bidder and seller pairs with suspicious bidding patterns."], ["Waitlist entries", o.waitlist_entries, "clock", "Students waiting for reserved items."],
    ["Open swap requests", o.open_swap_requests, "swap", "Swap requests waiting for an answer."], ["Active users (30d)", data.activeUsers, "user", "Students active in the last 30 days."], ["Avg sale price", o.avg_sale_price ? `₹${o.avg_sale_price}` : "-", "tag", "Average price of completed sales."],
  ] : [];
  return (
    <div>
      <PageTitle subtitle="Key numbers for the marketplace and a list of suspicious bidding to look at." action={<Tip text="Closes every auction whose time has run out and picks the winners." side="bottom" align="end"><button className="btn-secondary" onClick={async () => { if (!(await confirm({ title: "Close all finished auctions?", message: "Every auction whose end time has passed will be closed and its winner decided.", confirmLabel: "Close auctions" }))) return; const r = await apiFetch("/api/admin/close-auctions", { method: "POST", body: {} }); setMsg(`${r.closed} auctions closed`); reload(); }}>Close finished auctions</button></Tip>}>Admin overview</PageTitle>
      {msg && <Alert kind="success">{msg}</Alert>}
      <Async loading={loading} error={error}>
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map(([label, value, icon, tip]) => <StatCard key={label} label={label} value={value} icon={icon} tip={tip} />)}
        </div>
        <SectionTitle hint="Rule-based score from stored bids: rapid repeated bids, last-minute bids, large jumps, repeated bidding on one seller. Not machine learning." action={<Link className="link text-sm" href="/admin/analytics">More analytics</Link>}>Suspicious bidding</SectionTitle>
        {!data?.suspicious?.length ? <Empty icon="shield">No suspicious bidding detected.</Empty> : (
          <div className="card overflow-x-auto !p-0"><table className="w-full">
            <thead><tr><th className="th">Bidder</th><th className="th">Seller</th><th className="th">Bids</th><th className="th">Auctions</th><th className="th">Rapid</th><th className="th">Last minute</th><th className="th">Jumps</th><th className="th">Score</th><th className="th">Level</th></tr></thead>
            <tbody>{data.suspicious.map((r: any, i: number) => (
              <tr key={i}><td className="td">{r.bidder_name}</td><td className="td">{r.seller_name}</td><td className="td">{r.total_bids}</td><td className="td">{r.auctions_bid_on}</td><td className="td">{r.rapid_bids}</td><td className="td">{r.last_minute_bids}</td><td className="td">{r.jump_bids}</td><td className="td">{r.risk_score}</td><td className="td"><Badge tone={levelTone(r.risk_level)}>{r.risk_level}</Badge></td></tr>))}</tbody>
          </table></div>
        )}
      </Async>
    </div>
  );
}
