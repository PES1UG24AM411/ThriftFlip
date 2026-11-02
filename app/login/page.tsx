"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "@/lib/client";
import { resetLive } from "@/lib/realtime";
import { Alert, Tip } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const [role, setRole] = useState("STUDENT");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch("/api/auth/login", { method: "POST", body: { email, password, role } });
      resetLive(); // start with no data left over from a previous account
      router.push(r.role === "ADMIN" ? "/admin" : "/dashboard");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-md pt-4">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight">Welcome back</h1>
        <p className="mt-1 text-sm text-gray-600">Log in to buy, sell, bid and swap on campus.</p>
      </div>
      <form onSubmit={submit} className="card space-y-4 !p-6">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-brown/10 p-1">
          {["STUDENT", "ADMIN"].map((r) => (
            <Tip key={r} className="w-full" text={r === "STUDENT" ? "Log in as a student to buy, sell, bid and swap." : "Administrators only: reports, analytics and moderation."}>
              <button type="button" onClick={() => setRole(r)} aria-pressed={role === r} className={`w-full rounded-lg px-3 py-1.5 text-sm font-medium transition ${role === r ? "bg-brown text-cream shadow" : "text-brown hover:bg-brown/10"}`}>{r === "STUDENT" ? "Student" : "Admin"}</button>
            </Tip>
          ))}
        </div>
        <div><label className="label">E-mail</label><input className="input" type="email" placeholder="you@example.com" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /><p className="hint">The e-mail you registered with.</p></div>
        <div><label className="label">THRIFTFLIP password</label><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        {error && <Alert>{error}</Alert>}
        <button className="btn w-full" disabled={busy}>{busy ? "Logging in..." : "Log in"}</button>
        <p className="hint">Use your THRIFTFLIP password, never your PESU Academy password.</p>
        <p className="text-sm"><Link href="/forgot-password" className="link">Forgot your password?</Link></p>
        <p className="text-sm">No account? <Link href="/register" className="link">Register</Link></p>
      </form>
    </div>
  );
}
