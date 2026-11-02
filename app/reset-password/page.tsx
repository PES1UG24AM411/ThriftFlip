"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client";
import { Alert, PageTitle } from "@/components/ui";

export default function ResetPassword() {
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get("token") ?? ""); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try { await apiFetch("/api/auth/reset", { method: "POST", body: { token, password } }); setDone(true); } catch (err) { setError((err as Error).message); }
  }
  return (
    <div className="mx-auto max-w-md pt-4">
      <PageTitle subtitle="Pick a password you have not used elsewhere.">Choose a new password</PageTitle>
      {done ? <Alert kind="success">Password changed. <Link className="link" href="/login">Log in</Link></Alert> : (
        <form onSubmit={submit} className="card space-y-4 !p-6">
          <div><label className="label">New password (min 8 characters, letters and digits)</label><input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {!token && <Alert>This page needs the link from your e-mail.</Alert>}
          {error && <Alert>{error}</Alert>}
          <button className="btn w-full" disabled={!token}>Change password</button>
        </form>
      )}
    </div>
  );
}
