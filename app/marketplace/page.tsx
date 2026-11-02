"use client";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client";
import { useDebounced, useLiveData } from "@/lib/realtime";
import { Async, Empty, Help, ListingCard, PageTitle } from "@/components/ui";
import { Icon } from "@/components/icons";

const MODE_HELP: Record<string, string> = {
  browse: "Type any part of a title, author or ISBN, and narrow the results with the filters.",
  semantic: "Finds listings by meaning, so you can describe what you need in your own words (needs the embeddings to be generated).",
};

const EMPTY = { campusId: "", department: "", semester: "", type: "", condition: "", minPrice: "", maxPrice: "", courseCode: "", isbn: "", availability: "available", sort: "newest" };
type Filters = typeof EMPTY;

// Browse + filters (SQL, partial search) is the default. Semantic search (pgvector) is an optional extra under "More options".
export default function Marketplace() {
  const [mode, setMode] = useState<"browse" | "semantic">("browse");
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [f, setF] = useState<Filters>(EMPTY);
  const [departments, setDepartments] = useState<any[]>([]);
  const [campuses, setCampuses] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [ready, setReady] = useState(false);
  const set = (k: keyof Filters, v: string) => { setF((p) => ({ ...p, [k]: v })); setPage(1); };

  useEffect(() => {
    apiFetch("/api/reference?type=department-names").then(setDepartments).catch(() => {});
    apiFetch("/api/reference?type=campuses").then(setCampuses).catch(() => {});
    // links such as /marketplace?type=SWAP&q=algorithms pre-fill the form
    const qs = new URLSearchParams(window.location.search);
    const init: Filters = { ...EMPTY };
    (Object.keys(EMPTY) as Array<keyof Filters>).forEach((k) => { const v = qs.get(k); if (v) init[k] = v; });
    setF(init);
    if (qs.get("q")) { setText(qs.get("q")!); setSubmitted(qs.get("q")!); }
    setReady(true);
  }, []);

  let url: string | null = null;
  if (ready && mode === "browse") {
    const p = new URLSearchParams({ page: String(page) });
    if (submitted) p.set("q", submitted);
    (Object.keys(f) as Array<keyof Filters>).forEach((k) => { if (f[k] && !(k === "availability" && f[k] === "available") && !(k === "sort" && f[k] === "newest" && !submitted)) p.set(k, f[k]); });
    if (submitted && f.sort === "newest") p.delete("sort"); // text search sorts by relevance unless a sort is chosen
    url = `/api/listings?${p.toString()}`;
  } else if (ready && submitted) {
    url = `/api/search/semantic?q=${encodeURIComponent(submitted)}`;
  }
  // The results refresh by themselves every 2 seconds, so new, reserved and sold books appear without reloading.
  // The URL is delayed a little while the student types in a filter, so typing does not send a request per key.
  // Semantic search is not polled: it runs the embedding model on the server for every request.
  const liveUrl = useDebounced(url, 250);
  const { data, error, loading } = useLiveData(liveUrl, { interval: mode === "browse" ? undefined : 0 });
  const items: any[] = data?.items ?? [];
  const activeFilters = (Object.keys(f) as Array<keyof Filters>).filter((k) => f[k] && f[k] !== EMPTY[k]).length + (submitted ? 1 : 0);
  const advancedActive = ["courseCode", "isbn", "availability", "sort"].filter((k) => f[k as keyof Filters] && f[k as keyof Filters] !== EMPTY[k as keyof Filters]).length;

  function clearAll() { setF(EMPTY); setText(""); setSubmitted(""); setPage(1); setMode("browse"); }

  return (
    <div>
      <PageTitle subtitle="Find the books other students are selling, auctioning or swapping.">Marketplace</PageTitle>
      <form className="card mb-6 space-y-3" onSubmit={(e) => { e.preventDefault(); setSubmitted(text.trim()); setPage(1); }}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <label className="sr-only" htmlFor="q">Search</label>
            <input id="q" className="input" placeholder={mode === "semantic" ? "Describe the book, e.g. third year machine learning textbook" : "Search title, author or ISBN (part of a word is fine)..."} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <button className="btn sm:w-32"><Icon name="search" className="h-4 w-4" />Search</button>
        </div>
        <p className="hint !mt-0">{MODE_HELP[mode]}</p>

        {mode === "browse" && (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-7">
              <select aria-label="Listing type" className="input" value={f.type} onChange={(e) => set("type", e.target.value)}>
                <option value="">All types</option><option value="SALE">For sale</option><option value="AUCTION">Auction</option><option value="SWAP">Open to swap</option>
              </select>
              <select aria-label="Condition" className="input" value={f.condition} onChange={(e) => set("condition", e.target.value)}>
                <option value="">Any condition</option>{["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"].map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
              </select>
              <select aria-label="Campus" className="input" value={f.campusId} onChange={(e) => set("campusId", e.target.value)}>
                <option value="">Any campus</option>{campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select aria-label="Department" className="input" value={f.department} onChange={(e) => set("department", e.target.value)}>
                <option value="">Any department</option>{departments.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
              <select aria-label="Semester" className="input" value={f.semester} onChange={(e) => set("semester", e.target.value)}>
                <option value="">Any semester</option>{[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n} value={n}>Semester {n}</option>)}
              </select>
              <input aria-label="Minimum price" className="input" type="number" min="0" placeholder="Min ₹" value={f.minPrice} onChange={(e) => set("minPrice", e.target.value)} />
              <input aria-label="Maximum price" className="input" type="number" min="0" placeholder="Max ₹" value={f.maxPrice} onChange={(e) => set("maxPrice", e.target.value)} />
            </div>
            <details className="group rounded-xl border border-brown/15 bg-brown/5 p-3" open={advancedActive > 0 ? true : undefined}>
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold">
                <span className="flex items-center gap-2">More options {advancedActive > 0 && <span className="rounded-full bg-brown px-2 py-0.5 text-xs text-cream">{advancedActive} active</span>}</span>
                <Icon name="chevron" className="h-4 w-4 transition group-open:rotate-180" />
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <input aria-label="Course code" className="input" placeholder="Course code" value={f.courseCode} onChange={(e) => set("courseCode", e.target.value)} />
                <input aria-label="ISBN" className="input" placeholder="Exact ISBN" value={f.isbn} onChange={(e) => set("isbn", e.target.value)} />
                <select aria-label="Availability" className="input" value={f.availability} onChange={(e) => set("availability", e.target.value)}>
                  <option value="available">Available only</option><option value="all">Include reserved / sold</option>
                </select>
                <select aria-label="Sort by" className="input" value={f.sort} onChange={(e) => set("sort", e.target.value)}>
                  <option value="newest">Newest</option><option value="price_asc">Price: low to high</option>
                  <option value="price_desc">Price: high to low</option><option value="ending">Auctions ending soon</option>
                </select>
                <div className="col-span-2 flex items-center gap-1.5 md:col-span-4">
                  <label className="text-xs font-semibold" htmlFor="mode">Search style</label>
                  <Help text="Browse matches the words you type. Semantic search matches meaning and needs embeddings." align="start" />
                  <select id="mode" className="input max-w-[220px]" value={mode} onChange={(e) => { setMode(e.target.value as any); setSubmitted(text.trim()); }}>
                    <option value="browse">Words (default)</option><option value="semantic">Meaning (semantic)</option>
                  </select>
                </div>
              </div>
            </details>
          </>
        )}
        {mode === "semantic" && (
          <button type="button" className="text-sm font-semibold underline" onClick={() => setMode("browse")}>Back to normal search</button>
        )}
        {activeFilters > 0 && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">{activeFilters} filter{activeFilters === 1 ? "" : "s"} active</span>
            <button type="button" className="btn-secondary btn-sm" onClick={clearAll}>Clear all filters</button>
          </div>
        )}
      </form>

      {!url ? <Empty icon="search">Type what you need above and press Search.</Empty> : (
        <Async loading={loading} error={error}>
          {items.length === 0 ? (
            <Empty icon="book" action={activeFilters > 0 ? <button className="btn btn-sm" onClick={clearAll}>Clear all filters</button> : undefined}>No books match. Try fewer filters or a shorter search.</Empty>
          ) : (
            <>
              {mode === "browse" && data && <p className="mb-3 text-sm text-gray-600">{data.total} result{data.total === 1 ? "" : "s"}</p>}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{items.map((l) => <ListingCard key={l.listing_id} l={l} />)}</div>
            </>
          )}
          {mode === "browse" && data && data.total > data.pageSize && (
            <div className="mt-6 flex items-center justify-center gap-3">
              <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span className="text-sm">Page {page} of {Math.ceil(data.total / data.pageSize)}</span>
              <button className="btn-secondary" disabled={page * data.pageSize >= data.total} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </Async>
      )}
    </div>
  );
}
