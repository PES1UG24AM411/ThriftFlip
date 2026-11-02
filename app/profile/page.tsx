"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch, money, uploadFiles, useFetch } from "@/lib/client";
import { Alert, Async, Badge, Help, PageTitle, RatingLine, SectionTitle, Tip } from "@/components/ui";
import { useConfirm, useToast } from "@/components/feedback";

export default function Profile() {
  const confirm = useConfirm();
  const toast = useToast();
  const { data, error, loading, reload } = useFetch("/api/profile");
  const [departments, setDepartments] = useState<any[]>([]);
  const [f, setF] = useState({ semester: "1", departmentId: "", contactPreference: "IN_APP", phone: "", showContact: false });
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const me = data?.me;
  const rep = data?.ratingSummary;

  useEffect(() => {
    if (me?.campus_id) apiFetch(`/api/reference?type=departments&campusId=${me.campus_id}`).then(setDepartments).catch(() => {});
  }, [me?.campus_id]);
  useEffect(() => {
    if (me) setF({ semester: String(me.semester), departmentId: String(me.department_id), contactPreference: me.contact_preference, phone: me.phone ?? "", showContact: me.show_contact });
  }, [me]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await apiFetch("/api/profile", { method: "PUT", body: {
        semester: Number(f.semester), departmentId: Number(f.departmentId), contactPreference: f.contactPreference,
        phone: f.phone ? f.phone : null, showContact: f.showContact,
      } });
      setMsg({ kind: "success", text: "Profile updated" });
      toast.success("Profile updated");
      reload();
    } catch (err) { setMsg({ kind: "error", text: (err as Error).message }); }
  }
  async function photo(list: FileList | null) {
    const file = list?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return setMsg({ kind: "error", text: "The photo must be 2 MB or smaller" });
    try { await uploadFiles("/api/profile/photo", [file], "file"); reload(); } catch (err) { setMsg({ kind: "error", text: (err as Error).message }); }
  }

  return (
    <Async loading={loading} error={error}>
      {me && (
        <div>
          <PageTitle subtitle="Your details, rating and contact settings. Other students see your name, department and rating.">My profile</PageTitle>
          <div className="grid gap-5 md:grid-cols-2">
            <div className="card space-y-1 text-sm">
              <div className="mb-3 flex items-center gap-3">
                {me.profile_image_id ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/images/${me.profile_image_id}`} alt="" className="h-20 w-20 rounded-full border-2 border-brown/30 object-cover" />
                ) : <div className="flex h-20 w-20 items-center justify-center rounded-full bg-brown font-serif text-3xl text-cream">{me.name[0]}</div>}
                <div className="min-w-0 flex-1">
                  <p className="font-serif text-2xl font-bold">{me.name}</p>
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => photo(e.target.files)} className="w-full max-w-full text-xs" aria-label="Upload a profile photo" />
                  {me.profile_image_id && <button className="ml-2 text-xs font-semibold text-[#8f2d1f] underline" onClick={async () => { if (!(await confirm({ title: "Remove your profile photo?", confirmLabel: "Remove photo", tone: "danger" }))) return; await apiFetch("/api/profile/photo", { method: "DELETE" }); toast.success("Photo removed"); reload(); }}>Remove photo</button>}
                </div>
              </div>
              <p>{me.email}</p>
              <p>SRN {me.srn} · {me.program} · {me.department} · {me.campus} · semester {me.semester}</p>
              {me.warning_count > 0 && <p className="mt-2 font-semibold text-[#8a2616]">Moderation warnings: {me.warning_count}</p>}
              <h3 className="mt-3 font-sans text-base font-bold">Rating: <RatingLine avg={rep?.avg_rating} count={rep?.rating_count} /></h3>
              <p>Completed transactions: {rep?.completed_transactions} (sales/purchases {rep?.completed_sales}, swaps {rep?.completed_swaps})</p>
              <Link className="link inline-block pt-1" href={`/profile/${me.id}`}>See my public page</Link>
            </div>
            <form onSubmit={save} className="card space-y-4 text-sm">
              <h3 className="font-sans text-base font-bold">Edit profile</h3>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label">Course</label><input className="input" value="B.Tech" disabled /></div>
                <div><label className="label">Semester</label>
                  <select className="input" value={f.semester} onChange={(e) => setF({ ...f, semester: e.target.value })}>
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n} disabled={n < me.semester}>{n}</option>)}</select></div>
              </div>
              <div><label className="label">Department</label>
                <select className="input" value={f.departmentId} disabled={me.semester > 2} onChange={(e) => setF({ ...f, departmentId: e.target.value })}>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>{me.semester > 2 && <p className="hint">The department can only be changed in semesters 1 and 2.</p>}</div>
              <div><label className="label flex items-center gap-1.5">Preferred contact <Help text="How buyers should reach you. They only see it if you tick the box below." align="start" /></label>
                <select className="input" value={f.contactPreference} onChange={(e) => setF({ ...f, contactPreference: e.target.value })}>
                  <option value="IN_APP">THRIFTFLIP messages only</option><option value="EMAIL">E-mail</option><option value="PHONE">Phone</option></select></div>
              <div><label className="label">Phone (optional)</label><input className="input" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+919876543210" /><p className="hint">10 to 13 digits, optionally starting with +. Needed if your preferred contact is Phone.</p></div>
              <label className="flex items-start gap-2"><input className="mt-0.5" type="checkbox" checked={f.showContact} onChange={(e) => setF({ ...f, showContact: e.target.checked })} /> Show my preferred contact to buyers</label>
              {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
              <button className="btn">Save profile</button>
            </form>
          </div>
          <SectionTitle hint="Everything you listed. Click a title to edit it, mark it sold or delete it.">My listings</SectionTitle>
          <div className="card overflow-x-auto !p-0">
            <table className="w-full">
              <thead><tr><th className="th">Title</th><th className="th">Type</th><th className="th">Price</th><th className="th">Status</th></tr></thead>
              <tbody>{data.myListings.map((l: any) => (
                <tr key={l.listing_id}>
                  <td className="td"><Link className="link" href={`/listings/${l.listing_id}`}>{l.title}</Link></td>
                  <td className="td">{l.listing_type}</td><td className="td">{money(l.price)}</td><td className="td"><Badge>{l.status}</Badge></td>
                </tr>))}</tbody>
            </table>
          </div>
        </div>
      )}
    </Async>
  );
}
