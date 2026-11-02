"use client";
// Optional "books I would take in a swap": pick from the catalogue or type a title. At most 5.
import { useState } from "react";
import { apiFetch } from "@/lib/client";

export type Wanted = { bookId?: number; title: string };
export const toWantedPayload = (w: Wanted[]) => w.map((x) => (x.bookId ? { bookId: x.bookId } : { title: x.title }));

export default function WantedBooksPicker({ value, onChange }: { value: Wanted[]; onChange: (v: Wanted[]) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const full = value.length >= 5;

  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) return setResults([]);
    apiFetch(`/api/books?q=${encodeURIComponent(text.trim())}`).then(setResults).catch(() => {});
  }
  const add = (w: Wanted) => {
    if (full || value.some((x) => (w.bookId ? x.bookId === w.bookId : x.title.toLowerCase() === w.title.toLowerCase()))) return;
    onChange([...value, w]);
    setQ(""); setResults([]);
  };

  return (
    <div className="space-y-2 rounded-xl border border-brown/20 p-3 text-sm md:col-span-2">
      <p className="font-semibold">Books I would like in return (optional, up to 5)</p>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((w, i) => (
            <span key={i} className="inline-flex items-center gap-1 rounded-full bg-brown/10 px-2.5 py-1">
              {w.title}
              <button type="button" aria-label={`Remove ${w.title}`} className="font-bold text-[#8f2d1f]" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>
      )}
      {!full && (
        <>
          <input className="input" placeholder="Search the catalogue, or type any title" value={q} onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (q.trim().length >= 2) add({ title: q.trim() }); } }} />
          {results.length > 0 && (
            <ul className="max-h-40 overflow-auto rounded-lg border border-brown/15">
              {results.map((b) => <li key={b.id}><button type="button" className="block w-full px-2 py-1.5 text-left hover:bg-brown/5" onClick={() => add({ bookId: b.id, title: b.title })}>{b.title} <span className="text-xs text-gray-600">{b.author} · ed. {b.edition}</span></button></li>)}
            </ul>
          )}
          <button type="button" className="btn-secondary btn-sm" disabled={q.trim().length < 2} onClick={() => add({ title: q.trim() })}>Add &ldquo;{q.trim() || "title"}&rdquo; as typed</button>
        </>
      )}
      <p className="hint">Leave it empty if you are happy with any offer. Buyers see this list on your listing.</p>
    </div>
  );
}
