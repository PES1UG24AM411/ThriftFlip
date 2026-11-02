"use client";
import Link from "next/link";
import { ReactNode, useEffect, useState } from "react";
import { Icon, IconName } from "./icons";
import { bundledCover, safeCoverUrl } from "@/lib/covers";

// ---------------------------------------------------------------------------------------------
// Page layout helpers
// ---------------------------------------------------------------------------------------------
export function PageTitle({ children, action, subtitle }: { children: ReactNode; action?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold leading-tight sm:text-4xl">{children}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-gray-600">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export function SectionTitle({ children, hint, action }: { children: ReactNode; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 mt-8 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-xl font-bold">{children}{hint && <Help text={hint} />}</h2>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Tooltips: hover (mouse) or focus (keyboard / tap) shows a short explanation next to the element.
// The bubble is display:none until needed, so hidden tooltips never widen the page.
// ---------------------------------------------------------------------------------------------
export function Tip({ text, children, side = "top", align = "center", className = "" }: {
  text: ReactNode; children: ReactNode; side?: "top" | "bottom"; align?: "center" | "start" | "end"; className?: string;
}) {
  // Hidden tooltips use display:none (not just opacity 0), otherwise they would widen the page and cause sideways scrolling on phones.
  // A centred tooltip would run off the screen next to the left/right edge, so it is re-aligned when shown.
  const [auto, setAuto] = useState<"center" | "start" | "end">(align);
  const place = (el: HTMLElement) => {
    if (align !== "center") { setAuto(align); return; }
    const r = el.getBoundingClientRect();
    const mid = r.left + r.width / 2;
    setAuto(mid < 140 ? "start" : window.innerWidth - mid < 140 ? "end" : "center");
  };
  const v = side === "top" ? "bottom-full mb-2" : "top-full mt-2";
  const h = auto === "center" ? "left-1/2 -translate-x-1/2" : auto === "start" ? "left-0" : "right-0";
  return (
    <span className={`group/tip relative inline-flex ${className}`} onMouseEnter={(e) => place(e.currentTarget)} onFocusCapture={(e) => place(e.currentTarget)}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 hidden w-max max-w-[16rem] rounded-lg bg-brown px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-cream shadow-lift ring-1 ring-cream/20 group-hover/tip:block group-hover/tip:animate-tip-in group-focus-within/tip:block group-focus-within/tip:animate-tip-in ${v} ${h}`}
      >
        {text}
      </span>
    </span>
  );
}

// A small "?" next to a label or heading; hover or focus it to read the explanation.
export function Help({ text, align = "center" }: { text: ReactNode; align?: "center" | "start" | "end" }) {
  return (
    <Tip text={text} align={align}>
      <button type="button" aria-label="What is this?" className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-brown/40 text-[11px] font-bold leading-none text-brown transition hover:bg-brown hover:text-cream">?</button>
    </Tip>
  );
}

// Short instruction box. `id` makes "Hide" remembered in this browser (optional, per-visitor convenience only).
export function Hint({ id, title, children, icon = "info" }: { id?: string; title?: string; children: ReactNode; icon?: IconName }) {
  const [shown, setShown] = useState<boolean | null>(id ? null : true);
  useEffect(() => {
    if (!id) return;
    try { setShown(localStorage.getItem(`tf-hint-${id}`) !== "hidden"); } catch { setShown(true); }
  }, [id]);
  if (!shown) return null;
  return (
    <div className="mb-5 flex gap-3 rounded-xl border border-brown/20 bg-brown/5 p-4 text-sm">
      <Icon name={icon} className="mt-0.5 h-5 w-5 shrink-0 text-brown" />
      <div className="min-w-0 flex-1 text-gray-700">
        {title && <p className="mb-0.5 font-semibold text-brown">{title}</p>}
        {children}
      </div>
      {id && (
        <Tip text="Hide this tip" side="bottom" align="end">
          <button type="button" aria-label="Hide this tip" className="h-6 w-6 rounded-md text-gray-500 transition hover:bg-brown/10 hover:text-brown"
            onClick={() => { setShown(false); try { localStorage.setItem(`tf-hint-${id}`, "hidden"); } catch { /* ignore */ } }}>
            <Icon name="x" className="mx-auto h-4 w-4" />
          </button>
        </Tip>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Messages and states
// ---------------------------------------------------------------------------------------------
export function Alert({ kind = "error", children }: { kind?: "error" | "success" | "info"; children: ReactNode }) {
  const style = kind === "error"
    ? "border-[#d9a08c] bg-[#f6dccf] text-[#7d2415]"
    : kind === "success" ? "border-[#b3c47f] bg-[#e4ebc9] text-[#2f5428]" : "border-brown/25 bg-brown/5 text-brown";
  const icon: IconName = kind === "error" ? "alert" : kind === "success" ? "check" : "info";
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`my-3 flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm ${style}`}>
      <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex items-center gap-3 py-12 text-sm text-gray-600" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-brown/25 border-t-brown" />
      Loading...
    </div>
  );
}

export function Empty({ children, icon = "info", action }: { children: ReactNode; icon?: IconName; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-brown/30 bg-[#f9f4dd]/60 px-6 py-10 text-center text-sm text-gray-600">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brown/10 text-brown"><Icon name={icon} className="h-5 w-5" /></span>
      <div className="max-w-md">{children}</div>
      {action}
    </div>
  );
}

export type BadgeTone = "gray" | "green" | "yellow" | "red" | "blue";
export function Badge({ children, tone = "gray", tip }: { children: ReactNode; tone?: BadgeTone; tip?: ReactNode }) {
  const c = {
    gray: "bg-brown/10 text-brown",
    green: "bg-[#dce6bb] text-[#2f5428]",
    yellow: "bg-[#f0d78a] text-[#6b4700]",
    red: "bg-[#f1cdbd] text-[#8a2616]",
    blue: "bg-brown text-cream",
  }[tone];
  const el = <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${c}`}>{children}</span>;
  return tip ? <Tip text={tip} align="start">{el}</Tip> : el;
}
export const levelTone = (l: string) => (l === "HIGH" || l === "HIGH_RISK" ? "red" : l === "MEDIUM" || l === "SUSPICIOUS" ? "yellow" : "green");

// Shows loading / error / content for a useFetch result.
export function Async({ loading, error, children }: { loading: boolean; error: string | null; children: ReactNode }) {
  if (loading) return <Loading />;
  if (error) return <Alert>{error}</Alert>;
  return <>{children}</>;
}

// ---------------------------------------------------------------------------------------------
// Dashboard / summary tiles and progress steps
// ---------------------------------------------------------------------------------------------
export function StatCard({ label, value, icon, href, tip }: { label: string; value: ReactNode; icon: IconName; href?: string; tip?: string }) {
  const body = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brown/10 text-brown"><Icon name={icon} /></span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold uppercase leading-tight tracking-wide text-gray-600">{label}</span>
        <span className="block font-serif text-2xl font-bold leading-tight">{value}</span>
      </span>
    </>
  );
  const cls = "card flex items-center gap-3 !p-4";
  const el = href ? <Link href={href} className={`${cls} w-full`}>{body}</Link> : <div className={`${cls} w-full`}>{body}</div>;
  return tip ? <Tip text={tip} className="w-full" align="start">{el}</Tip> : el;
}

export function Stepper({ steps, current, cancelled }: { steps: { key: string; label: string; tip?: string }[]; current: string; cancelled?: boolean }) {
  const at = steps.findIndex((s) => s.key === current);
  return (
    <ol className="my-4 flex flex-wrap gap-y-3">
      {steps.map((s, i) => {
        const done = !cancelled && i < at;
        const active = !cancelled && i === at;
        return (
          <li key={s.key} className="flex min-w-[5.5rem] flex-1 flex-col items-center text-center">
            <Tip text={s.tip ?? s.label}>
              <span className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-bold transition ${done ? "border-brown bg-brown text-cream" : active ? "border-brown bg-cream text-brown ring-4 ring-brown/15" : "border-brown/25 text-gray-400"}`}>
                {done ? <Icon name="check" className="h-4 w-4" /> : i + 1}
              </span>
            </Tip>
            <span className={`mt-1 text-[11px] leading-tight ${active ? "font-bold text-brown" : "text-gray-500"}`}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------
// Average rating and number of ratings, or "Not rated yet"
export function RatingLine({ avg, count }: { avg: number | string | null | undefined; count: number | string | null | undefined }) {
  if (!Number(count)) return <span className="text-gray-500">Not rated yet</span>;
  return <span><span className="text-[#a26a00]">★</span> <b>{Number(avg).toFixed(1)}</b> ({Number(count)} {Number(count) === 1 ? "rating" : "ratings"})</span>;
}

// Listing card used by marketplace, wishlist, recently viewed, similar listings
// ---------------------------------------------------------------------------------------------
export function ListingCard({ l }: { l: any }) {
  return (
    <Link href={`/listings/${l.listing_id}`} className="card group block !p-0">
      <div className="overflow-hidden rounded-t-2xl">
        <ListingImage imageId={l.cover_image_id} coverUrl={l.cover_url} isbn={l.isbn} alt={l.title} className="h-44 w-full object-cover transition duration-300 group-hover:scale-105"
          placeholderClass="flex h-44 w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-[#eadfa8] to-[#e3d399] text-sm text-gray-600" />
      </div>
      <div className="p-4">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {l.is_mine && <Badge tone="gray" tip="This is your own listing.">Yours</Badge>}
          {l.status && l.status !== "ACTIVE" && <Badge tone="red" tip="This listing is not available to buy right now.">{l.status}</Badge>}
          <Badge tone={l.listing_type === "AUCTION" ? "yellow" : "blue"} tip={l.listing_type === "AUCTION" ? "Auction: place a bid. The highest bid when the timer ends wins." : "Fixed price: you can buy it right away at this price."}>{l.listing_type === "AUCTION" ? "Auction" : "Fixed price"}</Badge>
          {l.open_to_swap && <Badge tone="green" tip="The seller is also open to swapping this item for another book.">Swap</Badge>}
          {l.item_condition && <Badge tip="Condition of the item, as described by the seller.">{String(l.item_condition).replace("_", " ")}</Badge>}
        </div>
        <h3 className="font-sans text-base font-semibold leading-snug">{l.title}</h3>
        {l.author && <p className="text-xs text-gray-600">{l.author}{l.edition ? ` · ed. ${l.edition}` : ""}</p>}
        {(l.department_name || l.course_code) && <p className="text-xs text-gray-600">{[l.course_code, l.department_name, l.course_semester ? `sem ${l.course_semester}` : null].filter(Boolean).join(" · ")}</p>}
        <p className="mt-2 font-serif text-2xl font-bold">₹{Number(l.current_price ?? l.price).toLocaleString("en-IN")}</p>
        {l.open_to_swap && l.wanted_books && (
          <p className="mt-1 text-xs text-gray-700"><b>Wants in swap:</b> {String(l.wanted_books).split(" | ").join(", ")}</p>
        )}
        <p className="text-xs text-gray-600">
          {l.seller_name}{l.seller_rating_count !== undefined && <> · <RatingLine avg={l.seller_avg_rating} count={l.seller_rating_count} /></>}
          {l.similarity !== undefined ? ` · ${(Number(l.similarity) * 100).toFixed(0)}% match` : ""}
        </p>
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------------------------
// Picture of a listing. Order: photo uploaded by the student -> online book cover (book.cover_url) -> placeholder.
// A link that fails to load (404, blocked, offline) or that returns a 1x1 dummy picture moves on to the next choice.
// ---------------------------------------------------------------------------------------------
export function ListingImage({ imageId, coverUrl, isbn, alt, className, placeholderClass, placeholderText }: {
  imageId?: number | null; coverUrl?: string | null; isbn?: string | null; alt: string; className: string; placeholderClass: string; placeholderText?: string;
}) {
  // 1. student photo  2. online cover (book.cover_url)  3. cover file shipped with THRIFTFLIP (by ISBN)  4. placeholder
  const sources = Array.from(new Set([imageId ? `/api/images/${imageId}` : null, safeCoverUrl(coverUrl), bundledCover(isbn)].filter(Boolean) as string[]));
  const key = sources.join("|");
  const [failed, setFailed] = useState(0);
  useEffect(() => setFailed(0), [key]); // a different listing: start again with the first choice
  const src = sources[failed];
  if (!src) {
    return <div className={placeholderClass}><Icon name="book" className="h-8 w-8" /><span className="line-clamp-3 px-3 text-center">{placeholderText ?? alt}</span></div>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={src}
      src={src}
      alt={alt}
      className={className}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed((n) => n + 1)}
      onLoad={(e) => { if (e.currentTarget.naturalWidth <= 1) setFailed((n) => n + 1); }}
    />
  );
}
