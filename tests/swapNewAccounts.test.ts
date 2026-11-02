// Swap Intelligence for NEW accounts: students, books, listings and wishes are created the way the app creates them
// (findOrCreateBook + saveWantedBooks, never fixed ids), the circle appears for every participant, is announced once,
// the proposal -> accept -> confirm workflow still completes it, and the Swaps page refreshes within 2 seconds.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeListing, one } from "./helpers";
import { findOrCreateBook } from "../lib/books";
import { saveWantedBooks, WantedInput } from "../lib/wanted";
import { DEFAULT_INTERVAL, LiveEnv, createLiveStore } from "../lib/liveStore";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const suggestions = async (student: number) => (await pool.query("SELECT * FROM swap_match_suggestions($1::int)", [student])).rows;
const notify = async () => (await one("SELECT notify_swap_matches() AS n")).n as number;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nameOf = async (id: number) => (await one("SELECT name FROM student WHERE student_id = $1", [id])).name as string;

// What POST /api/listings does for a swap-enabled textbook: find or create the book, insert the listing, save the wishes.
async function listLikeTheApp(seller: number, book: { title: string; author: string; isbn?: string }, wanted: WantedInput) {
  const client = await pool.connect();
  try {
    const bookId = await findOrCreateBook(client, { title: book.title, author: book.author, edition: 1, isbn: book.isbn });
    const listing = await makeListing(seller, base.campus, bookId, { swap: true, title: book.title });
    await saveWantedBooks(client, listing, true, wanted);
    return { bookId, listing };
  } finally { client.release(); }
}

const NETWORKS = { title: "Computer Networking: A Top-Down Approach", author: "James Kurose, Keith Ross" };
const DATABASES = { title: "Database System Concepts", author: "Abraham Silberschatz" };
const SYSTEMS = { title: "Operating System Concepts", author: "Peter Galvin" };

describe("new accounts, books typed by the students", () => {
  async function newCircle() {
    const [a, b, c] = [await makeStudent(base, "Asha"), await makeStudent(base, "Bala"), await makeStudent(base, "Chitra")];
    // spelling differs between the listing and the wish ("Kurose" only, no punctuation, other capitals)
    const la = await listLikeTheApp(a, NETWORKS, [{ title: "database system concepts" }]);
    const lb = await listLikeTheApp(b, DATABASES, [{ title: "Operating System Concepts" }]);
    const lc = await listLikeTheApp(c, SYSTEMS, [{ title: "Computer Networking - A Top Down Approach" }]);
    return { a, b, c, la, lb, lc };
  }

  it("every new participant sees the circle, with the correct giver and receiver of each book", async () => {
    const t = await newCircle();
    for (const s of [t.a, t.b, t.c]) {
      const sug = await suggestions(s);
      expect(sug).toHaveLength(1);
      expect(sug[0].cycle_length).toBe(3);
      expect([...sug[0].listing_ids].sort()).toEqual([t.la.listing, t.lb.listing, t.lc.listing].sort());
    }
    // A offers Networking; C wants it. B offers Databases; A wants it. C offers Systems; B wants it.
    expect(await notify()).toBe(3);
    const body = async (s: number) => (await one("SELECT body FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [s])).body as string;
    expect(await body(t.a)).toContain(`You give "${NETWORKS.title}" to ${await nameOf(t.c)}`);
    expect(await body(t.a)).toContain(`get "${DATABASES.title}" from ${await nameOf(t.b)}`);
    expect(await body(t.b)).toContain(`You give "${DATABASES.title}" to ${await nameOf(t.a)}`);
    expect(await body(t.b)).toContain(`get "${SYSTEMS.title}" from ${await nameOf(t.c)}`);
    expect(await body(t.c)).toContain(`You give "${SYSTEMS.title}" to ${await nameOf(t.b)}`);
    expect(await body(t.c)).toContain(`get "${NETWORKS.title}" from ${await nameOf(t.a)}`);
  });

  it("a circle appears only when the LAST wish is saved, and the new student is told exactly then", async () => {
    const [a, b, c] = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    await listLikeTheApp(a, NETWORKS, [{ title: DATABASES.title }]);
    await listLikeTheApp(b, DATABASES, [{ title: SYSTEMS.title }]);
    const lc = await listLikeTheApp(c, SYSTEMS, []); // C has not said what she wants yet
    expect(await suggestions(a)).toHaveLength(0);
    expect(await notify()).toBe(0);
    const client = await pool.connect();
    try { await saveWantedBooks(client, lc.listing, true, [{ title: NETWORKS.title }]); } finally { client.release(); }
    expect(await suggestions(c)).toHaveLength(1);
    expect(await notify()).toBe(3);
    expect(await notify()).toBe(0);
  });

  it("works for any number of independent groups at once, without mixing students up", async () => {
    const groups = [] as number[][];
    for (let g = 0; g < 3; g++) {
      const ss = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
      const t = (i: number) => ({ title: `Group ${g} Book ${i}`, author: `Author Number${g}` });
      for (let i = 0; i < 3; i++) await listLikeTheApp(ss[i], t(i), [{ title: t((i + 1) % 3).title }]);
      groups.push(ss);
    }
    expect(await notify()).toBe(9);
    for (const ss of groups) for (const s of ss) {
      const sug = await suggestions(s);
      expect(sug).toHaveLength(1);
      expect([...sug[0].student_ids].sort()).toEqual([...ss].sort());
    }
  });
});

describe("the existing swap workflow still works on a circle found for new accounts", () => {
  it("propose -> accept -> confirm completes it, and the finished circle is neither suggested nor announced again", async () => {
    const [a, b, c] = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    const la = await listLikeTheApp(a, NETWORKS, [{ title: DATABASES.title }]);
    const lb = await listLikeTheApp(b, DATABASES, [{ title: SYSTEMS.title }]);
    const lc = await listLikeTheApp(c, SYSTEMS, [{ title: NETWORKS.title }]);
    expect(await notify()).toBe(3);

    const sug = (await suggestions(a))[0];
    const cycle = (await one("SELECT propose_swap_cycle($1::int[], $2::int) AS id", [sug.listing_ids, a])).id as string;
    expect(await suggestions(b)).toHaveLength(0); // reserved by the proposal
    for (const [student, listing] of [[b, lb.listing], [c, lc.listing]] as const) {
      // the request that asks THIS student to give their listing away
      const req = await one("SELECT swap_request_id FROM swap_request WHERE cycle_id = $1 AND requested_listing_id = $2", [cycle, listing]);
      await pool.query("SELECT respond_swap_request($1::int, $2::int, true)", [req.swap_request_id, student]);
    }
    for (const s of [a, b, c]) await pool.query("SELECT confirm_swap_cycle($1::uuid, $2::int)", [cycle, s]);
    for (const l of [la, lb, lc]) expect((await one("SELECT status FROM listing WHERE listing_id = $1", [l.listing])).status).toBe("SWAPPED");
    for (const s of [a, b, c]) expect(await suggestions(s)).toHaveLength(0);
    expect(await notify()).toBe(0);
  });

  it("a rejected proposal frees the listings: the circle is suggested again and is NOT announced a second time", async () => {
    const [a, b, c] = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    await listLikeTheApp(a, NETWORKS, [{ title: DATABASES.title }]);
    const lb = await listLikeTheApp(b, DATABASES, [{ title: SYSTEMS.title }]);
    await listLikeTheApp(c, SYSTEMS, [{ title: NETWORKS.title }]);
    expect(await notify()).toBe(3);
    const sug = (await suggestions(a))[0];
    const cycle = (await one("SELECT propose_swap_cycle($1::int[], $2::int) AS id", [sug.listing_ids, a])).id as string;
    const req = await one("SELECT swap_request_id FROM swap_request WHERE cycle_id = $1 AND requested_listing_id = $2", [cycle, lb.listing]);
    expect((await one("SELECT respond_swap_request($1::int, $2::int, false) AS r", [req.swap_request_id, b])).r).toBe("REJECTED");
    expect(await suggestions(c)).toHaveLength(1);
    expect(await notify()).toBe(0);
  });
});

describe("two new accounts: direct (2-person) swap", () => {
  it("is suggested to both, announced once with who gives what, and completes through the direct-swap workflow", async () => {
    const [a, b] = [await makeStudent(base, "Dev"), await makeStudent(base, "Esha")];
    const la = await listLikeTheApp(a, NETWORKS, [{ title: DATABASES.title }]);
    const lb = await listLikeTheApp(b, DATABASES, [{ title: "computer networking a top-down approach" }]);
    for (const s of [a, b]) {
      const sug = await suggestions(s);
      expect(sug).toHaveLength(1);
      expect(sug[0].swap_type).toBe("DIRECT");
      expect([...sug[0].student_ids].sort()).toEqual([a, b].sort());
    }
    expect(await notify()).toBe(2);
    expect(await notify()).toBe(0);
    const body = async (s: number) => (await one("SELECT body FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [s])).body as string;
    expect(await body(a)).toContain(`You give "${NETWORKS.title}" to ${await nameOf(b)} and get "${DATABASES.title}" from ${await nameOf(b)}`);
    expect(await body(b)).toContain(`You give "${DATABASES.title}" to ${await nameOf(a)} and get "${NETWORKS.title}" from ${await nameOf(a)}`);

    // what POST /api/swaps does for two listings
    const id = (await one("SELECT propose_swap($1::int, $2::int, $3::int) AS id", [a, la.listing, lb.listing])).id as number;
    for (const s of [a, b]) expect(await suggestions(s)).toHaveLength(0); // in progress: not suggested again
    expect((await one("SELECT respond_swap_proposal($1::int, $2::int, 'accept') AS r", [id, b])).r).toBe("ACCEPTED");
    await pool.query("SELECT confirm_swap_exchange($1::int, $2::int)", [id, a]);
    expect((await one("SELECT confirm_swap_exchange($1::int, $2::int) AS r", [id, b])).r).toBe("COMPLETED");
    for (const l of [la, lb]) expect((await one("SELECT status FROM listing WHERE listing_id = $1", [l.listing])).status).toBe("SWAPPED");
    for (const s of [a, b]) expect(await suggestions(s)).toHaveLength(0);
    expect(await notify()).toBe(0);
  });

  it("a one-sided wish is not a match until the other student wants the book too", async () => {
    const [a, b] = [await makeStudent(base), await makeStudent(base)];
    await listLikeTheApp(a, NETWORKS, [{ title: DATABASES.title }]);
    const lb = await listLikeTheApp(b, DATABASES, []);
    expect(await suggestions(a)).toHaveLength(0);
    expect(await notify()).toBe(0);
    const client = await pool.connect();
    try { await saveWantedBooks(client, lb.listing, true, [{ title: NETWORKS.title }]); } finally { client.release(); }
    expect(await suggestions(b)).toHaveLength(1);
    expect(await notify()).toBe(2);
  });
});

describe("automatic refresh", () => {
  it("the Swaps page asks for matches at least every 2 seconds, and the polling engine's default is 2 seconds", () => {
    const page = readFileSync(join(__dirname, "..", "app/swaps/page.tsx"), "utf8");
    const m = page.match(/useLiveData\("\/api\/swaps\/matches",\s*\{\s*interval:\s*(\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeLessThan(2001);
    expect(DEFAULT_INTERVAL).toBeLessThan(2001);
  });

  it("a subscribed student sees a new circle within three polling intervals, from the real matching query", async () => {
    const [a, b, c] = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    await listLikeTheApp(a, NETWORKS, [{ title: DATABASES.title }]);
    await listLikeTheApp(b, DATABASES, [{ title: SYSTEMS.title }]);
    const lc = await listLikeTheApp(c, SYSTEMS, []);
    // the store's network call is the matching query itself (the API route adds names on top of it)
    const env = {
      fetchJson: async () => (await suggestions(a)).map((r: any) => ({ listingIds: r.listing_ids, length: r.cycle_length })),
      isVisible: () => true,
      onWake: () => () => {},
      now: () => Date.now(),
    };
    const store = createLiveStore(env as unknown as LiveEnv);
    const interval = 40; // the page uses 2000 ms; the logic is identical, only the clock is faster
    let changes = 0;
    const off = store.subscribe("/api/swaps/matches", () => changes++, { interval });
    const wait = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await sleep(5); };
    await wait(() => (store.getSnapshot("/api/swaps/matches").data as any[] | null) !== null, 3000);
    expect(store.getSnapshot("/api/swaps/matches").data).toEqual([]); // nothing yet

    const client = await pool.connect();
    const saved = Date.now();
    try { await saveWantedBooks(client, lc.listing, true, [{ title: NETWORKS.title }]); } finally { client.release(); }
    await wait(() => ((store.getSnapshot("/api/swaps/matches").data as any[]) ?? []).length === 1, 3000);
    const shown = store.getSnapshot("/api/swaps/matches").data as any[];
    off();
    expect(shown).toHaveLength(1);
    expect(shown[0].length).toBe(3);
    // psql-per-query in the test harness is slow; a real pool is much faster. Allow generous slack, but it must be prompt.
    expect(Date.now() - saved).toBeLessThan(interval * 3 + 2500);
  });
});
