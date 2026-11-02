"use client";
import { useState } from "react";
import { apiFetch, dt, useFetch } from "@/lib/client";
import { Alert, Async, Badge, Empty, PageTitle, RatingLine } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";

export default function AdminUsers() {
  const confirm = useConfirm();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [text, setText] = useState<{ id: number; body: string } | null>(null);
  const { data, error, loading, reload } = useFetch(`/api/admin/users?q=${encodeURIComponent(q)}`);
  const noReason = reason.trim().length < 3;

  async function act(u: any, action: string, title: string, danger = false) {
    setMsg("");
    if (!(await confirm({ title, message: "The student is told the reason and the step is saved in the admin log.", confirmLabel: "Yes, do it", tone: danger ? "danger" : undefined }))) return;
    try { await apiFetch("/api/admin/actions", { method: "POST", body: { action, reason, studentId: u.student_id } }); toast.success("Done"); setReason(""); reload(); } catch (e) { setMsg((e as Error).message); }
  }
  async function send(u: any) {
    setMsg("");
    try { await apiFetch("/api/admin/messages", { method: "POST", body: { studentId: u.student_id, body: text!.body } }); toast.success("Message sent"); setText(null); } catch (e) { setMsg((e as Error).message); }
  }

  return (
    <div>
      <PageTitle subtitle="Find a student, send an official message, warn or suspend. Every action needs a reason.">Users</PageTitle>
      <div className="card mb-4 space-y-2">
        <input aria-label="Search students" className="input" placeholder="Search by name or email" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="label" htmlFor="user-reason">Reason for the next action (required)</label>
        <textarea id="user-reason" className="input" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {msg && <Alert>{msg}</Alert>}
      <Async loading={loading} error={error}>
        {!data?.length ? <Empty icon="user">No students found.</Empty> : data.map((u: any) => (
          <div key={u.student_id} className="card mb-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">{u.name} <Badge tone={u.status === "ACTIVE" ? "green" : "red"}>{u.status}</Badge></p>
              <span className="text-xs text-gray-500">Joined {dt(u.created_at)}</span>
            </div>
            <p>{u.email} · {u.active_listings} active listings · <RatingLine avg={u.avg_rating} count={u.rating_count} /> · warnings {u.warning_count} · reports against {u.reports_against}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn-secondary btn-sm" onClick={() => setText({ id: u.student_id, body: "" })}>Send message</button>
              <button className="btn-secondary btn-sm" disabled={noReason} onClick={() => act(u, "WARN_USER", `Warn ${u.name}?`)}>Warn</button>
              {u.status === "ACTIVE"
                ? <button className="btn-danger btn-sm" disabled={noReason} onClick={() => act(u, "SUSPEND_USER", `Suspend ${u.name}?`, true)}>Suspend</button>
                : <button className="btn-secondary btn-sm" disabled={noReason} onClick={() => act(u, "REACTIVATE_USER", `Reactivate ${u.name}?`)}>Reactivate</button>}
            </div>
            {text?.id === u.student_id && (
              <div className="mt-2 space-y-2">
                <textarea className="input" rows={2} maxLength={2000} placeholder="Official message" value={text?.body ?? ""} onChange={(e) => setText({ id: u.student_id, body: e.target.value })} />
                <button className="btn btn-sm" disabled={!text?.body?.trim()} onClick={() => send(u)}>Send</button>
              </div>
            )}
          </div>
        ))}
      </Async>
    </div>
  );
}
