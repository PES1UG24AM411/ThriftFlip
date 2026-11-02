"use client";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, dt, money, useFetch } from "@/lib/client";
import { Alert, Async, Badge, Empty, Hint, PageTitle, Tip } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";

const tone = (s: string) => (s === "PENDING" ? "yellow" : s === "UNDER_REVIEW" ? "blue" : s === "RESOLVED" ? "green" : "gray");
const label = (s: string) => s.replace("_", " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

// Evidence, history, messages and the allowed actions for one report. Every action needs a written reason.
function ReportDetail({ id, onChanged }: { id: number; onChanged: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const { data, error, loading, reload } = useFetch(`/api/admin/reports/${id}`);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, ok: string, clear: "reason" | "message") {
    if (busy) return;
    setBusy(true); setErr("");
    try { await fn(); toast.success(ok); if (clear === "reason") setReason(""); else setMessage(""); reload(); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const setStatus = (status: string, title: string) => async () => {
    if (await confirm({ title, message: "The reason is saved in the admin log.", confirmLabel: "Yes" })) run(() => apiFetch(`/api/admin/reports/${id}`, { method: "POST", body: { status, reason } }), "Report updated", "reason");
  };
  const act = (action: string, title: string, studentId?: number, listingId?: number, danger = false) => async () => {
    if (await confirm({ title, message: "The student is told the reason and the step is saved in the admin log.", confirmLabel: "Yes, do it", tone: danger ? "danger" : undefined }))
      run(() => apiFetch("/api/admin/actions", { method: "POST", body: { action, reason, studentId, listingId, reportId: id } }), "Done", "reason");
  };
  const send = (kind: "MESSAGE" | "CLARIFICATION", studentId: number, listingId?: number) =>
    run(() => apiFetch("/api/admin/messages", { method: "POST", body: { studentId, body: message, kind, reportId: id, listingId } }), "Message sent", "message");

  return (
    <Async loading={loading} error={error}>
      {data && (() => {
        const r = data.report;
        const underReview = r.status === "UNDER_REVIEW";
        const noReason = reason.trim().length < 3;
        return (
          <div className="mt-3 space-y-3 border-t border-brown/15 pt-3 text-sm">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg bg-brown/5 p-3">
                <p className="font-semibold">Evidence</p>
                <p>Filed by {r.reporter_name} on {dt(r.created_at)}</p>
                <p className="whitespace-pre-wrap">{r.details || "No details were written."}</p>
                {r.listing_id && <p className="mt-2">Listing: <Link className="link" href={`/listings/${r.listing_id}`}>{r.listing_title}</Link> · {money(r.listing_price)} · <Badge tone={r.listing_status === "ACTIVE" ? "green" : "red"}>{r.listing_status}</Badge>
                  <span className="block whitespace-pre-wrap text-gray-700">{r.listing_description}</span></p>}
              </div>
              <div className="rounded-lg bg-brown/5 p-3">
                <p className="font-semibold">Reported student</p>
                {r.reported_student_id ? <>
                  <p>{r.reported_name} · <Badge tone={r.reported_status === "ACTIVE" ? "green" : "red"}>{r.reported_status}</Badge></p>
                  <p>Warnings so far: {r.reported_warnings} · Other reports against them: {data.otherReports}</p>
                </> : <p>No student is attached to this report.</p>}
                {r.resolved_at && <p className="mt-2">Closed on {dt(r.resolved_at)}{r.resolved_by_name ? ` by ${r.resolved_by_name}` : ""}</p>}
              </div>
            </div>

            {(data.actions.length > 0 || data.messages.length > 0) && (
              <div>
                <p className="font-semibold">History</p>
                <ul className="space-y-1">
                  {data.actions.map((a: any) => <li key={`a${a.action_id}`} className="rounded bg-white/60 p-2"><b>{label(a.action)}</b> by {a.admin_name} · {dt(a.created_at)}<br /><span className="text-gray-700">{a.reason}</span></li>)}
                  {data.messages.map((m: any) => <li key={`m${m.admin_message_id}`} className={`rounded p-2 ${m.sender_type === "STUDENT" ? "bg-green-50" : "bg-blue-50"}`}><b>{m.sender_type === "STUDENT" ? `${m.student_name} replied` : `${m.admin_name} wrote (${label(m.kind)})`}</b> · {dt(m.created_at)}<br />{m.body}</li>)}
                </ul>
              </div>
            )}

            {err && <Alert>{err}</Alert>}
            {["PENDING", "UNDER_REVIEW"].includes(r.status) && (
              <div className="space-y-2">
                <label className="label" htmlFor={`reason-${id}`}>Reason / note for the admin log (required for every step)</label>
                <textarea id={`reason-${id}`} className="input" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why are you doing this?" />
                <div className="flex flex-wrap gap-2">
                  {r.status === "PENDING" && <Tip text="Start looking at this report. Nothing happens to anyone yet."><button className="btn btn-sm" disabled={busy || noReason} onClick={setStatus("UNDER_REVIEW", "Start the review?")}>Start review</button></Tip>}
                  {underReview && <>
                    {r.reported_student_id && <Tip text="Add a warning to the student and tell them why."><button className="btn-secondary btn-sm" disabled={busy || noReason} onClick={act("WARN_USER", "Warn this student?", r.reported_student_id)}>Warn user</button></Tip>}
                    {r.listing_id && r.listing_status === "ACTIVE" && <Tip text="Take the listing off the marketplace. The seller is told why."><button className="btn-secondary btn-sm" disabled={busy || noReason} onClick={act("REMOVE_LISTING", "Remove this listing?", undefined, r.listing_id, true)}>Remove listing</button></Tip>}
                    {r.reported_student_id && r.reported_status === "ACTIVE" && <Tip text="Suspend the account and remove its active listings. Use only for serious problems."><button className="btn-danger btn-sm" disabled={busy || noReason} onClick={act("SUSPEND_USER", "Suspend this student?", r.reported_student_id, undefined, true)}>Suspend user</button></Tip>}
                    <Tip text="The report was justified and you are finished with it."><button className="btn-secondary btn-sm" disabled={busy || noReason} onClick={setStatus("RESOLVED", "Mark as resolved?")}>Resolve</button></Tip>
                    <Tip text="The report was not justified. No action is taken against anyone."><button className="btn-secondary btn-sm" disabled={busy || noReason} onClick={setStatus("DISMISSED", "Dismiss this report?")}>Dismiss</button></Tip>
                  </>}
                </div>
                {!underReview && <p className="hint">Start the review first. Warnings, removals, suspensions and the final decision are only possible while a report is under review.</p>}
              </div>
            )}

            {r.reported_student_id && (
              <div className="space-y-2">
                <label className="label" htmlFor={`msg-${id}`}>Official message to {r.reported_name}</label>
                <textarea id={`msg-${id}`} className="input" rows={2} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="For example: please correct the description of your listing" />
                <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary btn-sm" disabled={busy || !message.trim()} onClick={() => send("MESSAGE", r.reported_student_id, r.listing_id ?? undefined)}>Send message</button>
                  <button className="btn-secondary btn-sm" disabled={busy || !message.trim()} onClick={() => send("CLARIFICATION", r.reported_student_id, r.listing_id ?? undefined)}>Ask for clarification</button>
                </div>
              </div>
            )}
          </div>
        );
      })()}
    </Async>
  );
}

export default function AdminReports() {
  const [status, setStatus] = useState("PENDING");
  const [open, setOpen] = useState<number | null>(null);
  const { data, error, loading, reload } = useFetch(`/api/admin/reports?status=${status}`);
  return (
    <div>
      <PageTitle subtitle="Reports sent by students. Nothing happens to anyone until an admin decides." action={<select aria-label="Filter reports by status" className="input w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setOpen(null); }}>
        <option value="PENDING">Pending</option><option value="UNDER_REVIEW">Under review</option><option value="RESOLVED">Resolved</option><option value="DISMISSED">Dismissed</option><option value="">All</option></select>}>Reports</PageTitle>
      <Hint id="reports-how-2" title="How a report is handled" icon="flag">Pending → <b>Start review</b> → look at the evidence, message the student if needed, then warn, remove a listing or suspend if justified → <b>Resolve</b> or <b>Dismiss</b>. Every step needs a reason, which is saved in the admin log and shown to the student.</Hint>
      <Async loading={loading} error={error}>
        {!data?.length ? <Empty icon="flag">No reports here.</Empty> : data.map((r: any) => (
          <div key={r.report_id} className="card mb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">{r.reason.replaceAll("_", " ")} <Badge tone={tone(r.status)}>{label(r.status)}</Badge></p>
              <span className="text-xs text-gray-500">{dt(r.created_at)}</span>
            </div>
            <p className="text-sm">Reported by {r.reporter_name}{r.reported_name ? ` against ${r.reported_name}` : ""}{r.listing_title ? ` about "${r.listing_title}"` : ""}</p>
            <button className="btn-secondary btn-sm mt-2" onClick={() => setOpen(open === r.report_id ? null : r.report_id)}>{open === r.report_id ? "Close" : "Open report"}</button>
            {open === r.report_id && <ReportDetail id={r.report_id} onChanged={reload} />}
          </div>
        ))}
      </Async>
    </div>
  );
}
