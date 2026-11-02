"use client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiFetch, uploadFiles, useFetch } from "@/lib/client";
import { Alert, Async, Hint, PageTitle, Tip } from "@/components/ui";
import WantedBooksPicker, { toWantedPayload, type Wanted } from "@/components/WantedBooksPicker";
import { useConfirm, useToast } from "@/components/feedback";

export default function EditListing() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const { data, error, loading, reload } = useFetch(`/api/listings/${id}`);
  const [f, setF] = useState({ title: "", description: "", condition: "GOOD", price: "", openToSwap: false });
  const [wanted, setWanted] = useState<Wanted[]>([]);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const l = data?.listing;

  useEffect(() => {
    if (l) setF({ title: l.title, description: l.description, condition: l.item_condition, price: String(l.price), openToSwap: l.open_to_swap });
  }, [l]);
  useEffect(() => {
    if (data?.wanted) setWanted(data.wanted.map((w: any) => ({ bookId: w.book_id ?? undefined, title: w.title })));
  }, [data?.wanted]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      await apiFetch(`/api/listings/${id}`, { method: "PUT", body: { title: f.title, description: f.description, condition: f.condition, price: l.listing_type === "AUCTION" ? undefined : Number(f.price), openToSwap: f.openToSwap, wantedBooks: l.listing_type === "FIXED_PRICE" ? toWantedPayload(f.openToSwap ? wanted : []) : undefined } });
      router.push(`/listings/${id}`);
    } catch (e2) { setErr((e2 as Error).message); }
  }
  async function remove() {
    if (!(await confirm({ title: "Delete this listing?", message: "The listing will be removed from the marketplace. Only active listings without bids can be deleted.", confirmLabel: "Delete listing", tone: "danger" }))) return;
    try { await apiFetch(`/api/listings/${id}`, { method: "DELETE" }); toast.success("Listing deleted"); router.push("/marketplace"); } catch (e2) { setErr((e2 as Error).message); }
  }
  async function markSold() {
    if (!(await confirm({ title: "Mark this book as sold?", message: "It will be removed from the marketplace.", confirmLabel: "Mark as sold" }))) return;
    try { await apiFetch(`/api/listings/${id}/sold`, { method: "POST", body: {} }); router.push(`/listings/${id}`); } catch (e2) { setErr((e2 as Error).message); }
  }
  async function addPhotos(list: FileList | null) {
    setErr(""); setInfo("");
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    if (files.some((x) => x.size > 2 * 1024 * 1024)) return setErr("Each image must be 2 MB or smaller");
    try { await uploadFiles(`/api/listings/${id}/images`, files); setInfo("Photos uploaded"); reload(); } catch (e2) { setErr((e2 as Error).message); }
  }
  async function removePhoto(imageId: number) {
    if (!(await confirm({ title: "Remove this photo?", confirmLabel: "Remove photo", tone: "danger" }))) return;
    try { await apiFetch(`/api/listings/${id}/images?imageId=${imageId}`, { method: "DELETE" }); toast.success("Photo removed"); reload(); } catch (e2) { setErr((e2 as Error).message); }
  }

  return (
    <Async loading={loading} error={error}>
      {l && !data.isOwner ? <Alert>This is not your listing.</Alert> : l && (
        <div className="mx-auto max-w-2xl">
          <PageTitle subtitle="Update your listing. Changes appear for buyers as soon as you save.">Edit listing</PageTitle>
          <div className="card mb-4">
            <h3 className="mb-1 font-sans font-bold">Photos ({data.images.length}/5)</h3>
            <p className="hint mb-2">Click the x on a photo to remove it. You can keep up to 1 photo.</p>
            <div className="mb-2 flex flex-wrap gap-2">
              {data.images.map((im: any) => (
                <div key={im.image_id} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/images/${im.image_id}`} alt="" className="h-20 w-20 rounded-lg border border-brown/20 object-cover" />
                  <Tip text="Remove this photo"><button type="button" aria-label="Remove photo" className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#8f2d1f] text-xs font-bold leading-none text-white transition hover:bg-[#762418]" onClick={() => removePhoto(im.image_id)}>×</button></Tip>
                </div>
              ))}
            </div>
            {data.images.length < 5 && <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => addPhotos(e.target.files)} />}
            {info && <Alert kind="success">{info}</Alert>}
          </div>
          <form onSubmit={save} className="card space-y-4">
            <div><label className="label">Title</label><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required /></div>
            <div><label className="label">Description</label><textarea className="input" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
            <div><label className="label">Condition</label>
              <select className="input" value={f.condition} onChange={(e) => setF({ ...f, condition: e.target.value })}>
                {["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"].map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select></div>
            {l.listing_type === "FIXED_PRICE" && (
              <>
                <div><label className="label">Price (₹)</label><input className="input" type="number" min="1" step="0.01" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} required /></div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.openToSwap} onChange={(e) => setF({ ...f, openToSwap: e.target.checked })} /> Open to swaps</label>
                {f.openToSwap && <WantedBooksPicker value={wanted} onChange={setWanted} />}
              </>
            )}
            {err && <Alert>{err}</Alert>}
            <div className="flex flex-wrap gap-2 border-t border-brown/15 pt-4">
              <button className="btn">Save changes</button>
              {l.status === "ACTIVE" && l.listing_type === "FIXED_PRICE" && <Tip text="Marks the item as sold and removes it from the marketplace."><button type="button" className="btn-secondary" onClick={markSold}>Mark as sold</button></Tip>}
              <Tip text="Permanently remove this listing. You will be asked to confirm."><button type="button" className="btn-danger" onClick={remove}>Delete listing</button></Tip>
            </div>
          </form>
        </div>
      )}
    </Async>
  );
}
