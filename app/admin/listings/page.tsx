"use client";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, dt, money, useFetch } from "@/lib/client";
import { Alert, Async, Badge, Empty, PageTitle, SectionTitle } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";

export default function AdminListings() {
  const confirm = useConfirm();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const listings = useFetch(`/api/admin/listings?q=${encodeURIComponent(q)}&status=${status}`);
  const reviews = useFetch("/api/admin/reviews");
  const noReason = reason.trim().length < 3;

  async function act(body: Record<string, unknown>, title: string, danger = false) {
    setMsg("");
    if (!(await confirm({ title, message: "The student is told the reason and the step is saved in the admin log.", confirmLabel: "Yes, do it", tone: danger ? "danger" : undefined }))) return;
    try { await apiFetch("/api/admin/actions", { method: "POST", body: { ...body, reason } }); toast.success("Done"); setReason(""); listings.reload(); reviews.reload(); } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div className="space-y-6">
      <PageTitle subtitle="Remove or restore listings and hide or restore reviews. Every action needs a reason.">Listings &amp; Reviews</PageTitle>
      <div className="card space-y-2">
        <label className="label" htmlFor="lr-reason">Reason for the next action (required)</label>
        <textarea id="lr-reason" className="input" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {msg && <Alert>{msg}</Alert>}

      <section>
        <SectionTitle>Listings</SectionTitle>
        <div className="mb-3 flex flex-wrap gap-2">
          <input aria-label="Search listings" className="input max-w-xs" placeholder="Search title or seller" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Filter by status" className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option><option value="ACTIVE">Active</option><option value="RESERVED">Reserved</option><option value="SOLD">Sold</option><option value="REMOVED">Removed</option></select>
        </div>
        <Async loading={listings.loading} error={listings.error}>
          {!listings.data?.length ? <Empty icon="store">No listings found.</Empty> : listings.data.map((l: any) => (
            <div key={l.listing_id} className="card mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span><Link className="link" href={`/listings/${l.listing_id}`}>{l.title}</Link> · {money(l.price)} · {l.seller_name} · {dt(l.created_at)} <Badge tone={l.status === "ACTIVE" ? "green" : l.status === "REMOVED" ? "red" : "gray"}>{l.status}</Badge>{l.reports > 0 && <> <Badge tone="yellow">{l.reports} reports</Badge></>}</span>
              {l.status === "ACTIVE" && <button className="btn-danger btn-sm" disabled={noReason} onClick={() => act({ action: "REMOVE_LISTING", listingId: l.listing_id }, `Remove "${l.title}"?`, true)}>Remove</button>}
              {l.status === "REMOVED" && l.listing_type === "FIXED_PRICE" && <button className="btn-secondary btn-sm" disabled={noReason} onClick={() => act({ action: "RESTORE_LISTING", listingId: l.listing_id }, `Restore "${l.title}"?`)}>Restore</button>}
            </div>
          ))}
        </Async>
      </section>

      <section>
        <SectionTitle>Reviews</SectionTitle>
        <Async loading={reviews.loading} error={reviews.error}>
          {!reviews.data?.length ? <Empty icon="shield">No written reviews yet.</Empty> : reviews.data.map((r: any) => (
            <div key={r.review_id} className="card mb-2 flex flex-wrap items-start justify-between gap-2 text-sm">
              <div>
                <p><b aria-label={`${r.score} out of 5 stars`}>{"★".repeat(r.score)}{"☆".repeat(5 - r.score)}</b> by {r.rater_name} about {r.ratee_name} · {dt(r.created_at)} {r.is_hidden && <Badge tone="red">Hidden</Badge>}</p>
                <p className="whitespace-pre-wrap">{r.body}</p>
                {r.is_hidden && <p className="text-xs text-gray-600">Reason: {r.hidden_reason}</p>}
              </div>
              {r.is_hidden
                ? <button className="btn-secondary btn-sm" disabled={noReason} onClick={() => act({ action: "RESTORE_REVIEW", reviewId: r.review_id }, "Restore this review?")}>Restore</button>
                : <button className="btn-danger btn-sm" disabled={noReason} onClick={() => act({ action: "HIDE_REVIEW", reviewId: r.review_id }, "Hide this review?", true)}>Hide</button>}
            </div>
          ))}
        </Async>
      </section>
    </div>
  );
}
