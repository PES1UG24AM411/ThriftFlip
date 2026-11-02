"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch, dt, money } from "@/lib/client";
import { useLiveData } from "@/lib/realtime";
import { Alert, Async, Badge, Empty, Hint, PageTitle, SectionTitle, Tip } from "@/components/ui";
import { useConfirm } from "@/components/feedback";

const tone = (s: string) => (s === "COMPLETED" || s === "ACCEPTED" ? "green" : s === "PENDING" ? "yellow" : "red");
// "READY": every student of the circle accepted, the books are reserved and everybody should exchange and confirm
const allCycleReady = (rs: any[], legacyTx: boolean) => !legacyTx && rs.every((r) => r.status === "ACCEPTED");

export default function Swaps() {
  const confirm = useConfirm();
  const router = useRouter();
  // Everything on this page refreshes by itself every 2 seconds, so proposals, answers, "everyone accepted" and
  // "completed" appear for every student without reloading. Matches run a heavier search on the server
  // (find_swap_cycles over all wanted books), so they refresh every 6 seconds (and at once after any action).
  const props = useLiveData("/api/swaps/proposals");
  const swaps = useLiveData("/api/swaps");
  const matches = useLiveData("/api/swaps/matches", { interval: 2000 });
  const wantedList = useLiveData("/api/wanted");
  const [wantQuery, setWantQuery] = useState("");
  const [wantResults, setWantResults] = useState<any[]>([]);
  const [wantAuthor, setWantAuthor] = useState("");
  const [offered, setOffered] = useState("");
  const [bookQuery, setBookQuery] = useState("");
  const [books, setBooks] = useState<any[]>([]);
  const [wanted, setWanted] = useState("");
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => { props.reload(); swaps.reload(); matches.reload(); wantedList.reload(); };
  async function run(fn: () => Promise<any>, ok: string | ((r: any) => string)) {
    if (busy) return; // one request at a time: no double clicks
    setBusy(true);
    setMsg(null);
    try { const r = await fn(); setMsg({ kind: "success", text: typeof ok === "function" ? ok(r) : ok }); refresh(); } catch (e) { setMsg({ kind: "error", text: (e as Error).message }); refresh(); } finally { setBusy(false); }
  }
  async function searchBooks(q: string) {
    setBookQuery(q);
    apiFetch(`/api/books?q=${encodeURIComponent(q)}`).then(setBooks).catch(() => {});
  }

  async function searchWanted(q: string) {
    setWantQuery(q);
    if (q.trim().length < 2) return setWantResults([]);
    apiFetch(`/api/books?q=${encodeURIComponent(q.trim())}`).then(setWantResults).catch(() => {});
  }
  const addWanted = (body: Record<string, unknown>) =>
    run(async () => { await apiFetch("/api/wanted", { method: "POST", body }); setWantQuery(""); setWantAuthor(""); setWantResults([]); }, "Added to your wanted books. You will be notified when a copy is open for swapping.");

  async function act(p: any, action: "accept" | "reject" | "cancel" | "confirm") {
    const texts = {
      accept: { title: `Accept: "${p.offered_title}" for your "${p.requested_title}"?`, message: "Both books are reserved for this swap. Nothing is final until you meet, exchange the books and both confirm.", confirmLabel: "Accept swap", ok: "Swap accepted. Both books are reserved." },
      reject: { title: "Reject this swap proposal?", message: "The other student is told it was rejected.", confirmLabel: "Reject", ok: "Proposal rejected.", tone: "danger" as const },
      cancel: { title: p.status === "ACCEPTED" ? "Call off this accepted swap?" : "Cancel this proposal?", message: p.status === "ACCEPTED" ? "Both books become available again and the other student is told." : "The other student is told it was cancelled.", confirmLabel: "Yes, cancel", ok: "Swap cancelled.", tone: "danger" as const },
      confirm: { title: "Did you really exchange the books?", message: "Only confirm after you have handed over your book and received theirs. The swap is completed when both students confirm.", confirmLabel: "Yes, we exchanged them", ok: "" },
    }[action];
    if (!(await confirm({ title: texts.title, message: texts.message, confirmLabel: texts.confirmLabel, tone: (texts as any).tone }))) return;
    run(() => apiFetch(`/api/swaps/proposals/${p.swap_proposal_id}`, { method: "POST", body: { action } }), (r) => action === "confirm" ? (r.result === "COMPLETED" ? "Swap completed! It now appears on your Deals page and you can rate the other student." : "Thanks. Waiting for the other student to confirm too.") : texts.ok);
  }

  const me: number | undefined = swaps.data?.me;
  const proposals: any[] = props.data?.proposals ?? [];
  // circular (multi-student) swaps: the requests of one swap share a cycle_id. Open ones come first; the 5 newest
  // finished ones (completed, rejected or called off) stay visible, so every student sees how the swap ended.
  const isOpenCycle = (rs: any[]) => rs.some((r) => ["PENDING", "ACCEPTED"].includes(r.status));
  const allCycles: any[][] = Object.values(((swaps.data?.requests ?? []) as any[]).reduce((m: Record<string, any[]>, r: any) => { (m[r.cycle_id] ??= []).push(r); return m; }, {}));
  const cycles: any[][] = [...allCycles.filter(isOpenCycle), ...allCycles.filter((rs) => !isOpenCycle(rs)).slice(0, 5)];

  async function cycleAct(cycleId: string, action: "confirm" | "cancel") {
    const ok = await confirm(action === "confirm"
      ? { title: "Did you really exchange the books?", message: "Only confirm after you handed over your book and received yours. The swap is completed when every student has confirmed.", confirmLabel: "Yes, we exchanged them" }
      : { title: "Call off this swap?", message: "The swap is cancelled for everybody and the books become available again.", confirmLabel: "Yes, call it off", tone: "danger" });
    if (!ok) return;
    run(() => apiFetch(`/api/swaps/cycles/${cycleId}`, { method: "POST", body: { action } }),
      (r) => r.result === "COMPLETED" ? "Swap completed! It now appears on your Deals page and you can rate the others." : r.result === "CANCELLED" ? "Swap called off." : "Thanks. Waiting for the other students to confirm too.");
  }

  return (
    <div className="space-y-6">
      <PageTitle subtitle="Trade a book you no longer need for one you want, directly with another student.">Swaps</PageTitle>
      <Hint id="swaps-how" title="How swaps work" icon="swap">
        <ol className="list-decimal space-y-0.5 pl-5">
          <li>Mark one of your listings <b>Open to swaps</b> (when you list or edit it) and add the <b>books you want</b> below.</li>
          <li>THRIFTFLIP notifies you when a wanted book is open for swapping, and when it finds a swap with two other students.</li>
          <li>Find a book marked &ldquo;Open to swap&rdquo; in the marketplace and press <b>Propose a swap</b>, choosing one of your own books.</li>
          <li>The owner <b>accepts or rejects</b>. When accepted, both books are <b>reserved</b>.</li>
          <li>Meet, exchange the books, then <b>both students confirm</b>. Only then is the swap complete and counted.</li>
        </ol>
        <p className="mt-1">Any extra money you agree is settled between you two. THRIFTFLIP does not process payments.</p>
      </Hint>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <section>
        <SectionTitle hint="Swaps you proposed or received, and where each one stands.">My swap proposals</SectionTitle>
        <Async loading={props.loading} error={props.error}>
          {proposals.length === 0 ? <Empty icon="swap" action={<Link href="/marketplace?type=SWAP" className="btn btn-sm">Browse swap-friendly books</Link>}>No swap proposals yet.</Empty> : proposals.map((p) => (
            <div key={p.swap_proposal_id} className="card mb-3 space-y-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2"><Badge tone={tone(p.status)}>{p.status}</Badge><span className="text-gray-600">{p.myRole === "PROPOSER" ? `You proposed to ${p.receiver_name}` : `${p.proposer_name} proposed to you`} · {dt(p.created_at)}</span></span>
              </div>
              <p>
                <b>{p.proposer_name}</b> gives <Link className="link" href={`/listings/${p.offered_listing_id}`}>{p.offered_title}</Link>
                {" "}and <b>{p.receiver_name}</b> gives <Link className="link" href={`/listings/${p.requested_listing_id}`}>{p.requested_title}</Link>.
              </p>
              {Number(p.settlement_amount) > 0 && <p>Agreed extra money: <b>{money(p.settlement_amount)}</b>, paid by {p.settlement_payer === "PROPOSER" ? p.proposer_name : p.receiver_name} (settled in person, not through THRIFTFLIP).</p>}
              {p.message && <p className="rounded-lg bg-brown/5 p-2 italic">&ldquo;{p.message}&rdquo;</p>}
              {p.status === "ACCEPTED" && (
                <p className="hint">
                  Confirmed: {p.proposer_name} {p.proposer_confirmed_at ? "yes" : "not yet"} · {p.receiver_name} {p.receiver_confirmed_at ? "yes" : "not yet"}
                </p>
              )}
              {p.status === "COMPLETED" && p.transaction_id && <p><Link className="link" href={`/transactions/${p.transaction_id}`}>View the finished deal and rate the other student</Link></p>}
              {["PENDING", "ACCEPTED"].includes(p.status) && (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Tip text="Chat with the other student about this swap."><button className="btn-secondary btn-sm" disabled={busy} onClick={() => run(async () => { const r = await apiFetch("/api/conversations", { method: "POST", body: { swapProposalId: p.swap_proposal_id } }); router.push(`/messages?c=${r.id}`); return r; }, "Chat opened")}>Message</button></Tip>
                </div>
              )}
              {p.actions.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {p.actions.includes("accept") && <Tip text="Agree to this swap. Both books get reserved."><button className="btn btn-sm" disabled={busy} onClick={() => act(p, "accept")}>Accept</button></Tip>}
                  {p.actions.includes("reject") && <Tip text="Decline this proposal."><button className="btn-secondary btn-sm" disabled={busy} onClick={() => act(p, "reject")}>Reject</button></Tip>}
                  {p.actions.includes("confirm") && <Tip text="Press this after you have really exchanged the books."><button className="btn btn-sm" disabled={busy} onClick={() => act(p, "confirm")}>We exchanged the books</button></Tip>}
                  {p.actions.includes("cancel") && <Tip text={p.status === "ACCEPTED" ? "Call off the swap before it is completed." : "Withdraw your proposal."}><button className="btn-secondary btn-sm" disabled={busy} onClick={() => act(p, "cancel")}>{p.status === "ACCEPTED" ? "Call off swap" : "Cancel proposal"}</button></Tip>}
                </div>
              )}
            </div>
          ))}
        </Async>
      </section>

      {cycles.length > 0 && (
        <section>
          <SectionTitle hint="Swaps between three students in a circle. Everybody must accept, then everybody must confirm the exchange.">Circular swaps</SectionTitle>
          {cycles.map((rs) => {
            const active = rs.some((r) => ["PENDING", "ACCEPTED"].includes(r.status));
            const allAccepted = rs.every((r) => r.status === "ACCEPTED");
            const iConfirmed = rs.some((r) => r.requester_id === me && r.confirmed_at);
            const iTake = rs.some((r) => r.requester_id === me);
            const legacyTx = rs.some((r) => r.has_transaction);
            const completed = rs.every((r) => r.status === "COMPLETED");
            return (
              <div key={rs[0].cycle_id} className="card mb-3 space-y-2 text-sm">
                <p>
                  <Badge tone="blue">{rs.length}-way swap</Badge>{" "}
                  {allCycleReady(rs, legacyTx) && <><Badge tone="green">Ready: exchange the books</Badge>{" "}</>}
                  {completed && <><Badge tone="green">Completed</Badge>{" "}</>}
                  <span className="text-gray-600">{dt(rs[0].created_at)}</span>
                </p>
                <ul className="space-y-1">
                  {rs.map((r) => (
                    <li key={r.swap_request_id} className="flex flex-wrap items-center gap-2">
                      <span><b>{r.owner_name}</b> gives <Link className="link" href={`/listings/${r.requested_listing_id}`}>{r.requested_title}</Link> to <b>{r.requester_name}</b></span>
                      <Badge tone={tone(r.status)}>{r.status === "PENDING" ? "Waiting for answer" : r.status}</Badge>
                      {allAccepted && <Badge tone={r.confirmed_at ? "green" : "gray"}>{r.confirmed_at ? "Exchanged" : "Not confirmed yet"}</Badge>}
                      {r.can_respond && <>
                        <button className="btn btn-sm" disabled={busy} onClick={() => run(() => apiFetch(`/api/swaps/${r.swap_request_id}`, { method: "POST", body: { accept: true } }), (x) => x.result === "READY" ? "Everyone accepted. The books are reserved: exchange them, then confirm." : "Accepted. Waiting for the others.")}>Accept</button>
                        <button className="btn-secondary btn-sm" disabled={busy} onClick={() => run(() => apiFetch(`/api/swaps/${r.swap_request_id}`, { method: "POST", body: { accept: false } }), "Swap rejected")}>Reject</button>
                      </>}
                    </li>
                  ))}
                </ul>
                {allAccepted && !legacyTx && <p className="hint">Everyone accepted. After you meet and exchange the books, each student confirms. The swap is completed only when all {rs.length} have confirmed.</p>}
                {completed && <p className="hint">All {rs.length} students confirmed. The swap is complete: it is on your <Link className="link" href="/transactions">Deals page</Link>, where you can rate the others.</p>}
                {!active && !completed && <p className="hint">This swap was called off. The books are available again.</p>}
                {active && iTake && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {allAccepted && !legacyTx && !iConfirmed && <button className="btn btn-sm" disabled={busy} onClick={() => cycleAct(rs[0].cycle_id, "confirm")}>We exchanged the books</button>}
                    {allAccepted && !legacyTx && iConfirmed && <span className="hint">You confirmed. Waiting for the others.</span>}
                    <button className="btn-secondary btn-sm" disabled={busy} onClick={() => cycleAct(rs[0].cycle_id, "cancel")}>Call off swap</button>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      <section>
        <SectionTitle hint="Found automatically from the books people want: two students swapping directly, or three students in a circle (A has X and wants Y, B has Y and wants Z, C has Z and wants X). Nothing happens until everybody agrees.">Swap matches found for you</SectionTitle>
        <Async loading={matches.loading} error={matches.error}>
          {!matches.data?.length ? <Empty icon="swap">No matches yet. Add the books you want in return (below or on your listing), or browse the marketplace for books that are open to swap.</Empty> : (
            <div className="grid gap-4 md:grid-cols-2">
              {matches.data.map((m: any, i: number) => (
                <div key={i} className="card">
                  <Badge tone="blue">{m.length === 2 ? "Direct swap" : `${m.length}-way swap`}</Badge>{m.alternatives > 0 && <span className="hint ml-2">{m.alternatives} other cop{m.alternatives === 1 ? "y" : "ies"} would work too</span>}
                  <ol className="mt-2 list-decimal pl-5 text-sm">
                    {m.items.map((it: any) => (
                      <li key={it.listing_id}>{it.seller_id === me ? <b>You</b> : it.seller_name} {it.seller_id === me ? "give" : "gives"} <b>{it.title}</b> to {it.gives_to_id === me ? <b>you</b> : it.gives_to}
                        {it.seller_id !== me && <> · <button className="link" disabled={busy} onClick={() => run(async () => { const r = await apiFetch("/api/conversations", { method: "POST", body: { listingId: it.listing_id } }); router.push(`/messages?c=${r.id}`); return r; }, "Chat opened")}>Message {it.seller_name}</button></>}
                      </li>
                    ))}
                  </ol>
                  <button className="btn mt-4" disabled={busy} onClick={async () => { if (await confirm({ title: "Propose this swap?", message: "The other students are notified and can accept or reject. Nothing is final until everybody has confirmed the exchange.", confirmLabel: "Propose swap" })) run(() => apiFetch("/api/swaps", { method: "POST", body: { listingIds: m.listingIds } }), "Swap proposed. The other students were notified."); }}>Propose this swap</button>
                </div>
              ))}
            </div>
          )}
        </Async>
      </section>

      <section>
        <SectionTitle hint="Any book you would like to get, even if nobody sells it yet. You are notified when a copy becomes open for swapping, and the books you own that are open to swap are matched with it.">Books I want</SectionTitle>
        <div className="card space-y-3">
          <input aria-label="Search for a book you want" className="input" placeholder="Search for a book by title, author or subject" value={wantQuery} onChange={(e) => searchWanted(e.target.value)} />
          {wantResults.length > 0 && (
            <ul className="max-h-48 overflow-auto rounded-lg border border-brown/15 text-sm">
              {wantResults.map((b) => <li key={b.id}><button type="button" className="block w-full px-2 py-1.5 text-left hover:bg-brown/5" disabled={busy} onClick={() => addWanted({ bookId: b.id })}>{b.title} <span className="text-xs text-gray-600">{b.author} · ed. {b.edition} · click to add</span></button></li>)}
            </ul>
          )}
          {wantQuery.trim().length >= 2 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="hint">Not in the list?</span>
              <input aria-label="Author (optional)" className="input max-w-[200px]" placeholder="Author (optional)" value={wantAuthor} onChange={(e) => setWantAuthor(e.target.value)} />
              <button className="btn-secondary btn-sm" disabled={busy} onClick={() => addWanted({ title: wantQuery.trim(), author: wantAuthor.trim() || undefined })}>Add &ldquo;{wantQuery.trim()}&rdquo; as a new book</button>
            </div>
          )}
          <Async loading={wantedList.loading} error={wantedList.error}>
            <ul className="text-sm">
              {!(wantedList.data ?? []).length && <li className="hint">You have not added any wanted book yet.</li>}
              {(wantedList.data ?? []).map((w: any) => (
                <li key={w.wanted_book_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-brown/15 py-2">
                  <span><b>{w.title}</b> <span className="text-gray-600">{w.author} · ed. {w.edition}</span> {w.swappable_copies > 0 ? <Badge tone="green">{w.swappable_copies} open for swap now</Badge> : <Badge tone="gray">none open for swap yet</Badge>}</span>
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => run(() => apiFetch(`/api/wanted?id=${w.wanted_book_id}`, { method: "DELETE" }), "Removed from your wanted books")}>Remove</button>
                </li>
              ))}
            </ul>
          </Async>
        </div>
      </section>

      <section>
        <SectionTitle hint="Choose one of your swap-enabled listings and the book you would like instead. THRIFTFLIP uses this to find matches.">What I want in return</SectionTitle>
        <div className="card space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <select aria-label="My swap-enabled listing" className="input" value={offered} onChange={(e) => setOffered(e.target.value)}>
              <option value="">My swap-enabled listing...</option>
              {(swaps.data?.myListings ?? []).map((l: any) => <option key={l.listing_id} value={l.listing_id}>{l.title}</option>)}
            </select>
            <input aria-label="Search the book I want" className="input" placeholder="Search the book I want" value={bookQuery} onChange={(e) => searchBooks(e.target.value)} />
            <select aria-label="Wanted book" className="input" value={wanted} onChange={(e) => setWanted(e.target.value)}>
              <option value="">Wanted book...</option>
              {books.map((b) => <option key={b.id} value={b.id}>{b.title} (ed. {b.edition})</option>)}
            </select>
          </div>
          <Tip text={!offered || !wanted ? "Choose one of your listings and a wanted book first." : "Save this wish so matching can find swaps for you."}><button className="btn" disabled={!offered || !wanted || busy} onClick={() => run(() => apiFetch("/api/swaps/preferences", { method: "POST", body: { offeredListingId: Number(offered), wantedBookId: Number(wanted) } }), "Preference saved")}>Add preference</button></Tip>
          <ul className="text-sm">
            {!(swaps.data?.preferences ?? []).length && <li className="hint">No preferences yet. Add one above.</li>}
            {(swaps.data?.preferences ?? []).map((p: any) => (
              <li key={p.preference_id} className="flex flex-wrap items-center justify-between gap-2 border-t border-brown/15 py-2">
                <span>Give <b>{p.offered_title}</b>, want <b>{p.wanted_title}</b></span>
                <button className="btn-secondary btn-sm" onClick={async () => { if (await confirm({ title: "Remove this preference?", confirmLabel: "Remove", tone: "danger" })) run(() => apiFetch(`/api/swaps/preferences?id=${p.preference_id}`, { method: "DELETE" }), "Preference removed"); }}>Remove</button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
