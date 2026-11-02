"use client";
import WantedBooksPicker, { toWantedPayload, type Wanted } from "@/components/WantedBooksPicker";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { apiFetch, money, uploadFiles } from "@/lib/client";
import { Alert, Help, Hint, PageTitle } from "@/components/ui";

const MAX_BYTES = 2 * 1024 * 1024;

export default function NewListing() {
  const router = useRouter();
  const [f, setF] = useState({ category: "TEXTBOOK", title: "", author: "", edition: "1", isbn: "", courseId: "", condition: "GOOD", description: "", listingType: "FIXED_PRICE", price: "", openToSwap: false, durationHours: "48", minIncrement: "10" });
  const [courses, setCourses] = useState<any[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [wanted, setWanted] = useState<Wanted[]>([]);
  const [suggestion, setSuggestion] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  useEffect(() => { apiFetch("/api/reference?type=courses").then(setCourses).catch(() => {}); }, []);

  function pick(list: FileList | null) {
    const chosen = Array.from(list ?? []);
    if (chosen.length > 1) return setError("You can add at most 1 photo");
    const big = chosen.find((x) => x.size > MAX_BYTES);
    if (big) return setError(`${big.name} is larger than 2 MB`);
    setError("");
    setFiles(chosen);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await apiFetch("/api/listings", {
        method: "POST",
        body: {
          category: f.category, title: f.title, author: f.category === "TEXTBOOK" ? f.author : undefined,
          edition: Number(f.edition), isbn: f.category === "TEXTBOOK" ? f.isbn : undefined,
          courseId: f.category === "TEXTBOOK" && f.courseId ? Number(f.courseId) : null,
          condition: f.condition, description: f.description, listingType: f.listingType, price: Number(f.price),
          openToSwap: f.listingType === "FIXED_PRICE" && f.openToSwap,
          wantedBooks: f.listingType === "FIXED_PRICE" && f.openToSwap ? toWantedPayload(wanted) : undefined, durationHours: Number(f.durationHours), minIncrement: Number(f.minIncrement),
        },
      });
      if (files.length > 0) await uploadFiles(`/api/listings/${r.id}/images`, files);
      router.push(`/listings/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const fp = suggestion?.fairPrice;
  const previews = useMemo(() => files.map((x) => ({ name: x.name, url: URL.createObjectURL(x) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);
  const lbl = (text: string, help?: string) => <label className="label flex items-center gap-1.5">{text}{help && <Help text={help} align="start" />}</label>;

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle subtitle="Fill in the details below. Clear photos and an honest condition help your item sell faster.">Sell a book</PageTitle>
      <Hint id="new-listing" title="Before you publish">
        Pick <b>Fixed price</b> to sell at one price right away, or <b>Auction</b> to let students bid. You can edit the price and description later from your listing page.
      </Hint>
      <form onSubmit={submit} className="space-y-5">
        <section className="card grid gap-4 md:grid-cols-2">
          <h2 className="text-lg font-bold md:col-span-2">1. What are you selling?</h2>
          <div>{lbl("Category", "Book for textbooks and study material. Other goods for anything else, such as a calculator or lab coat.")}
            <select className="input" value={f.category} onChange={(e) => set("category", e.target.value)}>
              <option value="TEXTBOOK">Book</option><option value="GOODS">Other goods</option></select></div>
          <div>{lbl("Condition", "Be honest. Buyers can report listings with wrong descriptions. New = unused, Like new = barely used, Good = normal wear, Fair = clearly used, Poor = heavily worn.")}
            <select className="input" value={f.condition} onChange={(e) => set("condition", e.target.value)}>
              {["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"].map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select></div>
          <div className="md:col-span-2">{lbl(f.category === "TEXTBOOK" ? "Book title" : "Title")}<input className="input" value={f.title} onChange={(e) => set("title", e.target.value)} placeholder={f.category === "TEXTBOOK" ? "e.g. Database System Concepts" : "e.g. Scientific calculator"} required /></div>
          {f.category === "TEXTBOOK" && (
            <>
              <div>{lbl("Author")}<input className="input" value={f.author} onChange={(e) => set("author", e.target.value)} required /></div>
              <div>{lbl("Edition")}<input className="input" type="number" min="1" value={f.edition} onChange={(e) => set("edition", e.target.value)} required /></div>
              <div>{lbl("ISBN (optional)", "The 10 or 13 digit number near the barcode on the back cover. It helps buyers and the price estimate find the right book.")}<input className="input" value={f.isbn} onChange={(e) => set("isbn", e.target.value)} placeholder="10 or 13 digits" /></div>
              <div>{lbl("Course code (optional)", "Link the book to a course so students looking for that subject can find it.")}
                <select className="input" value={f.courseId} onChange={(e) => set("courseId", e.target.value)}>
                  <option value="">Not listed / not sure</option>
                  {courses.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name} ({c.department}, sem {c.semester})</option>)}
                </select></div>
            </>
          )}
          <div className="md:col-span-2">{lbl("Description")}<textarea className="input" rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Highlighting, notes, missing pages..." /></div>
        </section>

        <section className="card space-y-3">
          <h2 className="text-lg font-bold">2. Photos</h2>
          <div>{lbl("Add photos", "1 photo, JPEG, PNG or WebP, 2 MB maximum. Show the cover and a sample page.")}
            <input className="input" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => pick(e.target.files)} />
            <p className="hint">1 photo, JPEG, PNG or WebP, 2 MB maximum. Show the cover and a sample page.</p></div>
          {previews.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {previews.map((p) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={p.url} src={p.url} alt={p.name} title={p.name} className="h-20 w-20 rounded-lg border border-brown/20 object-cover" />
              ))}
            </div>
          )}
        </section>

        <section className="card grid gap-4 md:grid-cols-2">
          <h2 className="text-lg font-bold md:col-span-2">3. Price</h2>
          <div>{lbl("Sale type", "Fixed price: the first buyer gets it at your price. Auction: students bid and the highest bid wins when the timer ends.")}
            <select className="input" value={f.listingType} onChange={(e) => set("listingType", e.target.value)}>
              <option value="FIXED_PRICE">Fixed price</option><option value="AUCTION">Auction</option></select></div>
          <div>{lbl(f.listingType === "AUCTION" ? "Starting price (₹)" : "Price (₹)")}
            <input className="input" type="number" min="1" step="0.01" value={f.price} onChange={(e) => set("price", e.target.value)} required /></div>
          {f.listingType === "AUCTION" ? (
            <>
              <div>{lbl("Duration (hours)", "How long the auction runs, from 1 hour up to 7 days (168 hours). Late bids can extend it.")}<input className="input" type="number" min="1" max="168" value={f.durationHours} onChange={(e) => set("durationHours", e.target.value)} /></div>
              <div>{lbl("Minimum bid increment (₹)", "How much higher each new bid must be than the current price.")}<input className="input" type="number" min="1" value={f.minIncrement} onChange={(e) => set("minIncrement", e.target.value)} /></div>
            </>
          ) : (
            <>
            <label className="flex items-start gap-2 text-sm md:col-span-2"><input className="mt-0.5" type="checkbox" checked={f.openToSwap} onChange={(e) => set("openToSwap", e.target.checked)} /> <span><b>Open to swaps</b><span className="hint block !mt-0">Tick this if you would also trade this item for another book. Optionally list the books you would like in return.</span></span></label>
            {f.openToSwap && f.listingType === "FIXED_PRICE" && <WantedBooksPicker value={wanted} onChange={setWanted} />}
            </>
          )}
          {fp?.estimated_price && <div className="md:col-span-2"><Alert kind="info">Estimated fair price: <b>{money(fp.estimated_price)}</b></Alert></div>}
        </section>

        <div>{error && <Alert>{error}</Alert>}<button className="btn w-full !py-3 text-base" disabled={busy}>{busy ? "Publishing..." : "Publish listing"}</button></div>
      </form>
    </div>
  );
}
