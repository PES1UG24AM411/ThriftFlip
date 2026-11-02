"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client";
import { Alert, Help, PageTitle } from "@/components/ui";
import { REG_MSG, RegField, validateRegistration } from "@/lib/validation/registration";

type Option = { id: number; name: string };
type LoadState = "loading" | "ok" | "error";

export default function RegisterPage() {
  const router = useRouter();
  const [f, setF] = useState({ srn: "", name: "", email: "", password: "", campusId: "", departmentId: "", semester: "1" });
  const [campuses, setCampuses] = useState<Option[]>([]);
  const [campusState, setCampusState] = useState<LoadState>("loading");
  const [departments, setDepartments] = useState<Option[]>([]);
  const [deptState, setDeptState] = useState<LoadState | "idle">("idle");
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null); // e-mail address after a successful registration
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RegField, string>>>({});
  const [accountExists, setAccountExists] = useState(false);
  const set = (k: string, v: string) => {
    setF((p) => ({ ...p, [k]: v }));
    setFieldErrors((p) => (p[k as RegField] ? { ...p, [k]: undefined } : p)); // clear a field's message as soon as it is edited
  };
  // props shared by every input that can show an error
  const bad = (k: RegField) => ({ className: `input${fieldErrors[k] ? " input-error" : ""}`, "aria-invalid": !!fieldErrors[k], "aria-describedby": fieldErrors[k] ? `${k}-error` : undefined });
  const FieldError = ({ k }: { k: RegField }) => (fieldErrors[k] ? <p id={`${k}-error`} role="alert" className="mt-1 text-xs text-red-400">{fieldErrors[k]}</p> : null);

  // 1. campuses come from the database
  const loadCampuses = useCallback(async () => {
    setCampusState("loading");
    setLoadError("");
    try {
      const list = await apiFetch<Option[]>("/api/reference?type=campuses");
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error("No campuses found in the database. Run `npm run db:migrate` (or `npm run db:reset`) and reload this page.");
      }
      setCampuses(list);
      setCampusState("ok");
    } catch (e) {
      setLoadError((e as Error).message);
      setCampusState("error");
    }
  }, []);
  useEffect(() => { loadCampuses(); }, [loadCampuses]);

  // 2. after a campus is chosen, that campus's departments are loaded
  const loadDepartments = useCallback(async (campusId: string) => {
    setDepartments([]);
    setF((p) => ({ ...p, departmentId: "" }));
    if (!campusId) { setDeptState("idle"); return; }
    setDeptState("loading");
    setLoadError("");
    try {
      const list = await apiFetch<Option[]>(`/api/reference?type=departments&campusId=${campusId}`);
      if (!Array.isArray(list) || list.length === 0) throw new Error("This campus has no departments in the database.");
      setDepartments(list);
      setDeptState("ok");
    } catch (e) {
      setLoadError((e as Error).message);
      setDeptState("error");
    }
  }, []);
  useEffect(() => { loadDepartments(f.campusId); }, [f.campusId, loadDepartments]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // ignore repeated clicks while the request is running
    setError("");
    setAccountExists(false);
    // same rules as the API (lib/validation/registration.ts)
    const problems = validateRegistration(f as Record<RegField, string>);
    setFieldErrors(problems);
    if (Object.keys(problems).length) {
      setError(Object.values(problems).every((m) => m === REG_MSG.missing) ? REG_MSG.missing : "Please correct the highlighted fields.");
      return;
    }
    setBusy(true);
    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        body: { srn: f.srn, name: f.name, email: f.email, password: f.password, departmentId: Number(f.departmentId), semester: Number(f.semester) },
      });
      setDone(f.email.trim().toLowerCase());
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ex = err as any;
      const fields = (ex.fields ?? {}) as Record<string, string>;
      // messages from the server go under the matching inputs
      setFieldErrors(Object.fromEntries(Object.entries(fields).filter(([k]) => ["srn", "name", "email", "password", "departmentId", "semester"].includes(k))));
      setAccountExists(["SRN_EXISTS", "EMAIL_EXISTS", "ACCOUNT_EXISTS"].includes(ex.code));
      setError(ex.message);
      setF((p) => ({ ...p, password: "" })); // keep everything except the password
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mx-auto max-w-lg">
        <PageTitle>Account created</PageTitle>
        <div className="card space-y-3 text-sm">
          <Alert kind="success">Registration successful! Your THRIFTFLIP account has been created.</Alert>
          <button className="btn-secondary w-full" onClick={() => { router.push("/marketplace"); router.refresh(); }}>Go to the marketplace</button>
        </div>
      </div>
    );
  }

  const campusLabel = campusState === "loading" ? "Loading campuses..." : campusState === "error" ? "Could not load campuses" : "Select campus...";
  const deptLabel = !f.campusId ? "Select campus first..." : deptState === "loading" ? "Loading departments..." : deptState === "error" ? "Could not load departments" : "Select department...";

  return (
    <div className="mx-auto max-w-xl pt-2">
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-extrabold tracking-tight">Create your account</h1>
        <p className="mt-1 text-sm text-gray-600">Join your campus marketplace in under a minute.</p>
      </div>
      <form onSubmit={submit} noValidate className="card grid gap-4 !p-6 md:grid-cols-2">
        <div><label className="label flex items-center gap-1.5" htmlFor="srn">Student ID (SRN) <Help text="Your university student number, printed on your ID card. Letters and digits only, 8 to 20 characters." align="start" /></label>
          <input id="srn" {...bad("srn")} value={f.srn} onChange={(e) => set("srn", e.target.value)} placeholder="PES1UG24AM411" autoComplete="off" required /><FieldError k="srn" /><p className="hint">Letters and digits, e.g. PES1UG24AM411</p></div>
        <div><label className="label" htmlFor="name">Name</label>
          <input id="name" {...bad("name")} value={f.name} onChange={(e) => set("name", e.target.value)} autoComplete="name" required /><FieldError k="name" /></div>
        <div className="md:col-span-2"><label className="label" htmlFor="email">E-mail</label>
          <input id="email" {...bad("email")} type="email" placeholder="you@gmail.com" value={f.email} onChange={(e) => set("email", e.target.value)} autoComplete="email" required />
          <FieldError k="email" />
          <p className="hint">Any valid e-mail works (Gmail, Outlook, college...). Used for login and password reset.</p></div>
        <div><label className="label" htmlFor="course">Course</label>
          <input id="course" className="input" value="B.Tech" disabled readOnly /></div>
        <div><label className="label" htmlFor="campus">Campus</label>
          <select id="campus" {...bad("campusId")} value={f.campusId} onChange={(e) => set("campusId", e.target.value)} disabled={campusState !== "ok"} required>
            <option value="">{campusLabel}</option>
            {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select><FieldError k="campusId" /></div>
        <div><label className="label" htmlFor="department">Department</label>
          <select id="department" {...bad("departmentId")} value={f.departmentId} onChange={(e) => set("departmentId", e.target.value)} disabled={deptState !== "ok"} required>
            <option value="">{deptLabel}</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select><FieldError k="departmentId" /></div>
        <div><label className="label" htmlFor="semester">Semester</label>
          <select id="semester" {...bad("semester")} value={f.semester} onChange={(e) => set("semester", e.target.value)}>
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select><FieldError k="semester" /></div>
        {(campusState === "error" || deptState === "error") && (
          <div className="md:col-span-2">
            <Alert>{loadError}</Alert>
            <button type="button" className="btn-secondary" onClick={() => (campusState === "error" ? loadCampuses() : loadDepartments(f.campusId))}>Try again</button>
          </div>
        )}
        <div className="md:col-span-2"><label className="label" htmlFor="password">THRIFTFLIP password</label>
          <input id="password" {...bad("password")} type="password" value={f.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" required />
          <FieldError k="password" />
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {[["At least 8 characters", f.password.length >= 8], ["A letter", /[A-Za-z]/.test(f.password)], ["A digit", /[0-9]/.test(f.password)]].map(([t, ok]) => (
              <li key={String(t)} className={ok ? "font-semibold text-[#2f5428]" : "text-gray-500"}>{ok ? "✓" : "○"} {t}</li>
            ))}
          </ul>
          <p className="hint">Choose a new password. Never enter your PESU Academy password here.</p></div>
        <div className="md:col-span-2">
          {error && (
            <Alert>
              {error}
              {accountExists && <> <Link href="/login" className="font-semibold underline">Log in</Link></>}
            </Alert>
          )}
          <button className="btn w-full" disabled={busy || deptState !== "ok" || !f.departmentId}>{busy ? "Creating..." : "Register"}</button>
          <p className="mt-2 text-sm">Already registered? <Link href="/login" className="link">Log in</Link></p>
        </div>
      </form>
    </div>
  );
}
