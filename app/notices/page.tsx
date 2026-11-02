"use client";
import Link from "next/link";
import { useState } from "react";
import { apiFetch, dt } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Alert, Async, Badge, Empty, PageTitle } from "@/components/ui";
import { useToast } from "@/components/feedback";

const tone = (k: string) => (k === "WARNING" ? "red" : k === "CLARIFICATION" ? "yellow" : "blue");

export default function Notices() {
  const toast = useToast();
  const { data, error, loading, reload } = useLiveData("/api/notices"); // new admin messages appear by themselves
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const last = (data ?? []).find((m: any) => m.sender_type === "ADMIN");

  async function reply(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setErr("");
    try {
      await apiFetch("/api/notices", { method: "POST", body: { body, reportId: last?.report_id ?? undefined, listingId: undefined } });
      toast.success("Reply sent to the admins"); setBody(""); reload();
    } catch (ex) { setErr((ex as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle subtitle="Official messages, warnings and notices from the administrators. You can answer them here.">Messages from admins</PageTitle>
      <Async loading={loading} error={error}>
        {!data?.length ? <Empty icon="chat">No messages from the admins.</Empty> : (
          <>
            {data.map((m: any) => (
              <div key={m.admin_message_id} className={`card mb-3 text-sm ${m.sender_type === "STUDENT" ? "ml-8 bg-green-50" : ""}`}>
                <p><Badge tone={m.sender_type === "STUDENT" ? "green" : tone(m.kind)}>{m.sender_type === "STUDENT" ? "Your reply" : m.kind}</Badge> <span className="text-xs text-gray-500">{dt(m.created_at)}</span></p>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
                {m.listing_id && m.sender_type === "ADMIN" && <p className="mt-1"><Link className="link" href={`/listings/${m.listing_id}/edit`}>Open the listing to correct it</Link></p>}
              </div>
            ))}
            <form onSubmit={reply} className="card space-y-2">
              <label className="label" htmlFor="notice-reply">Reply to the admins</label>
              <textarea id="notice-reply" className="input" rows={3} maxLength={2000} value={body} onChange={(e) => setBody(e.target.value)} required />
              {err && <Alert>{err}</Alert>}
              <button className="btn" disabled={busy || !body.trim()}>{busy ? "Sending..." : "Send reply"}</button>
            </form>
          </>
        )}
      </Async>
    </div>
  );
}
