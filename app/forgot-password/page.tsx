"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { Alert, PageTitle } from "@/components/ui";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");
  const [devLink, setDevLink] = useState("");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(""); setMsg(""); setDevLink("");
    try { const r = await apiFetch("/api/auth/forgot", { method: "POST", body: { email } }); setMsg(r.message); if (r.devResetLink) setDevLink(r.devResetLink); } catch (err) { setError((err as Error).message); }
  }
  return (
    <div className="mx-auto max-w-md pt-4">
      <PageTitle subtitle="Enter the e-mail you registered with. We will send you a link to choose a new password.">Forgot password</PageTitle>
      <form onSubmit={submit} className="card space-y-4 !p-6">
        <div><label className="label">E-mail</label><input className="input" type="email" placeholder="you@example.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        {error && <Alert>{error}</Alert>}
        {msg && <Alert kind="success">{msg}</Alert>}
        {devLink && <Alert kind="info">Development mode (no SMTP): <a className="underline" href={devLink}>open the reset page</a></Alert>}
        <button className="btn w-full">Send reset link</button>
      </form>
    </div>
  );
}
