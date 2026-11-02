// Swap Intelligence: direct and three-student circles must be found from the configured preferences, whoever starts
// the search, with the correct books, only for available listings, and each circle is announced once.
// (Regression for migration 020: a second catalogue row of the same book, and typed wanted titles, were never matched.)
import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, one } from "./helpers";
import { saveWantedBooks } from "../lib/wanted";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const pref = (student: number, listing: number, wantedBook: number) =>
  pool.query("INSERT INTO swap_preference (student_id, offered_listing_id, wanted_book_id) VALUES ($1, $2, $3)", [student, listing, wantedBook]);
const cycles = async (student: number | null = null, max = 3) =>
  (await pool.query("SELECT * FROM find_swap_cycles($1::int, $2::int)", [student, max])).rows;
const suggestions = async (student: number | null = null) =>
  (await pool.query("SELECT * FROM swap_match_suggestions($1::int)", [student])).rows;
const count = async (sql: string, params: unknown[] = []) => (await one(`SELECT COUNT(*)::int AS n FROM (${sql}) x`, params)).n as number;
const notify = async () => (await one("SELECT notify_swap_matches() AS n")).n as number;
const setStatus = (listing: number, status: string) => pool.query("UPDATE listing SET status = $2 WHERE listing_id = $1", [listing, status]);

// A has X wants Y, B has Y wants Z, C has Z wants X (preferences saved per listing, as the Swaps page does)
async function circle(o: { wantXBook?: (x: number) => Promise<number> } = {}) {
  const [a, b, c] = [await makeStudent(base, "A"), await makeStudent(base, "B"), await makeStudent(base, "C")];
  const [x, y, z] = [
    await makeBook(base.course, { title: "Computer Networking", author: "James Kurose, Keith Ross" }),
    await makeBook(base.course, { title: "Database Systems", author: "Ramez Elmasri" }),
    await makeBook(base.course, { title: "Operating Systems", author: "Abraham Silberschatz" }),
  ];
  const la = await makeListing(a, base.campus, x, { swap: true, title: "Computer Networking" });
  const lb = await makeListing(b, base.campus, y, { swap: true, title: "Database Systems" });
  const lc = await makeListing(c, base.campus, z, { swap: true, title: "Operating Systems" });
  await pref(a, la, y); await pref(b, lb, z); await pref(c, lc, o.wantXBook ? await o.wantXBook(x) : x);
  return { a, b, c, x, y, z, la, lb, lc };
}

describe("three-student circle A -> B -> C -> A", () => {
  it("is found once, whichever student starts the search", async () => {
    const t = await circle();
    const all = await cycles(null);
    expect(all).toHaveLength(1);
    expect(all[0].cycle_length).toBe(3);
    expect(all[0].swap_type).toBe("MULTI_WAY");
    for (const s of [t.a, t.b, t.c]) {
      const mine = await cycles(s);
      expect(mine).toHaveLength(1);
      expect([...mine[0].listing_ids].sort()).toEqual([t.la, t.lb, t.lc].sort());
      expect([...mine[0].student_ids].sort()).toEqual([t.a, t.b, t.c].sort());
    }
  });

  it("is found when the students' listing ids are in any order (the smallest listing need not belong to A)", async () => {
    const [a, b, c] = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    const [x, y, z] = [await makeBook(base.course), await makeBook(base.course), await makeBook(base.course)];
    const lc = await makeListing(c, base.campus, z, { swap: true });
    const la = await makeListing(a, base.campus, x, { swap: true });
    const lb = await makeListing(b, base.campus, y, { swap: true });
    await pref(a, la, y); await pref(b, lb, z); await pref(c, lc, x);
    for (const s of [null, a, b, c]) expect(await cycles(s)).toHaveLength(1);
  });

  it("is found from the wanted-books list, and from a mix of preferences and the list", async () => {
    const [a, b, c] = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    const [x, y, z] = [await makeBook(base.course), await makeBook(base.course), await makeBook(base.course)];
    const la = await makeListing(a, base.campus, x, { swap: true });
    const lb = await makeListing(b, base.campus, y, { swap: true });
    await makeListing(c, base.campus, z, { swap: true });
    await pref(a, la, y);
    await pool.query("INSERT INTO student_wanted_book (student_id, book_id) VALUES ($1, $2), ($3, $4)", [b, z, c, x]);
    expect(await cycles(null)).toHaveLength(1);
  });

  it("tells every student what they give, to whom, and what they get from whom", async () => {
    const t = await circle();
    expect(await notify()).toBe(3);
    const sa = (await one("SELECT body FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [t.a])).body as string;
    const nameOf = async (id: number) => (await one("SELECT name FROM student WHERE student_id = $1", [id])).name as string;
    // A owns X and gives it to C (C wants X); A wants Y and gets it from B
    expect(sa).toContain('You give "Computer Networking" to ' + (await nameOf(t.c)));
    expect(sa).toContain('get "Database Systems" from ' + (await nameOf(t.b)));
    const sb = (await one("SELECT body FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [t.b])).body as string;
    expect(sb).toContain('You give "Database Systems" to ' + (await nameOf(t.a)));
    expect(sb).toContain('get "Operating Systems" from ' + (await nameOf(t.c)));
  });
});

describe("direct two-student swap", () => {
  it("is found, from both students, as DIRECT", async () => {
    const [a, b] = [await makeStudent(base), await makeStudent(base)];
    const [x, y] = [await makeBook(base.course), await makeBook(base.course)];
    const la = await makeListing(a, base.campus, x, { swap: true });
    const lb = await makeListing(b, base.campus, y, { swap: true });
    await pref(a, la, y); await pref(b, lb, x);
    for (const s of [null, a, b]) {
      const found = await cycles(s);
      expect(found).toHaveLength(1);
      expect(found[0].swap_type).toBe("DIRECT");
    }
    expect(await notify()).toBe(2);
  });

  it("is not found when only one side wants the other's book", async () => {
    const [a, b] = [await makeStudent(base), await makeStudent(base)];
    const [x, y] = [await makeBook(base.course), await makeBook(base.course)];
    const la = await makeListing(a, base.campus, x, { swap: true });
    await makeListing(b, base.campus, y, { swap: true });
    await pref(a, la, y);
    expect(await cycles(null)).toHaveLength(0);
  });
});

describe("matching uses the book, not one catalogue row or the exact text", () => {
  it("finds the circle when one student wants a second catalogue row of the same book", async () => {
    const t = await circle({
      // same title and a compatible author, different ISBN: a duplicate catalogue row (what real data had)
      wantXBook: (x) => makeBook(base.course, { title: "computer networking.", author: "Kurose" }),
    });
    for (const s of [null, t.a, t.b, t.c]) expect(await cycles(s)).toHaveLength(1);
  });

  it("does not treat a different edition or a different book as the same", async () => {
    const t = await circle({ wantXBook: () => makeBook(base.course, { title: "Computer Networking", author: "James Kurose", edition: 2 }) });
    expect(await cycles(null)).toHaveLength(0);
    const other = await makeBook(base.course, { title: "Computer Graphics", author: "James Kurose" });
    await pool.query("UPDATE swap_preference SET wanted_book_id = $2 WHERE student_id = $1 AND offered_listing_id = $3", [t.c, other, t.lc]);
    expect(await cycles(null)).toHaveLength(0);
  });

  it("finds the circle when a wanted book was typed as a title (the catalogue had no such book yet)", async () => {
    const [a, b, c] = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    const [x, y, z] = [await makeBook(base.course, { title: "Book X" }), await makeBook(base.course, { title: "Book Y" }), await makeBook(base.course, { title: "Book Z" })];
    const la = await makeListing(a, base.campus, x, { swap: true, title: "Book X" });
    const lb = await makeListing(b, base.campus, y, { swap: true, title: "Book Y" });
    const lc = await makeListing(c, base.campus, z, { swap: true, title: "Book Z" });
    await pool.query("INSERT INTO listing_wanted_book (listing_id, custom_title) VALUES ($1, 'book y'), ($2, 'Book Z!'), ($3, 'BOOK X')", [la, lb, lc]);
    for (const s of [null, a, b, c]) expect(await cycles(s)).toHaveLength(1);
  });

  it("saveWantedBooks stores a typed title as the catalogue book when it exists (structured preference)", async () => {
    const a = await makeStudent(base);
    const book = await makeBook(base.course, { title: "Database Systems" });
    const la = await makeListing(a, base.campus, await makeBook(base.course), { swap: true });
    const client = await pool.connect();
    try {
      await saveWantedBooks(client, la, true, [{ title: "database SYSTEMS" }, { title: "Nobody Sells This" }]);
    } finally { client.release(); }
    expect(await count("SELECT 1 FROM swap_preference WHERE offered_listing_id = $1 AND wanted_book_id = $2", [la, book])).toBe(1);
    expect(await count("SELECT 1 FROM listing_wanted_book WHERE listing_id = $1 AND book_id = $2", [la, book])).toBe(1);
    expect(await count("SELECT 1 FROM listing_wanted_book WHERE listing_id = $1 AND custom_title = 'Nobody Sells This'", [la])).toBe(1);
  });
});

describe("invalid circles", () => {
  it("a broken chain (C wants a book nobody offers) is not a circle", async () => {
    const t = await circle();
    const nobody = await makeBook(base.course);
    await pool.query("UPDATE swap_preference SET wanted_book_id = $1 WHERE student_id = $2", [nobody, t.c]);
    for (const s of [null, t.a, t.b, t.c]) expect(await cycles(s)).toHaveLength(0);
  });

  it("the same student twice is not a three-way swap (A has two listings)", async () => {
    const [a, b] = [await makeStudent(base), await makeStudent(base)];
    const [x, x2, y] = [await makeBook(base.course), await makeBook(base.course), await makeBook(base.course)];
    const la = await makeListing(a, base.campus, x, { swap: true });
    const la2 = await makeListing(a, base.campus, x2, { swap: true });
    const lb = await makeListing(b, base.campus, y, { swap: true });
    await pref(a, la, y); await pref(b, lb, x2); await pref(a, la2, y);
    const found = await cycles(null, 3);
    expect(found.every((c: any) => new Set(c.student_ids).size === c.student_ids.length)).toBe(true);
    expect(found.every((c: any) => c.cycle_length === 2)).toBe(true); // only the direct A <-> B swap exists
  });

  it("a student never matches with their own listing", async () => {
    const a = await makeStudent(base);
    const x = await makeBook(base.course);
    const la = await makeListing(a, base.campus, x, { swap: true });
    await pref(a, la, x);
    expect(await cycles(null)).toHaveLength(0);
  });

  it("the opposite direction is its own circle, and give / receive are reversed accordingly", async () => {
    const t = await circle();
    // A wants Z (from C), B wants X (from A), C wants Y (from B): the circle runs the other way round
    await pool.query("DELETE FROM swap_preference");
    await pref(t.a, t.la, t.z); await pref(t.b, t.lb, t.x); await pref(t.c, t.lc, t.y);
    expect(await cycles(null)).toHaveLength(1);
    expect(await notify()).toBe(3);
    const nameOf = async (id: number) => (await one("SELECT name FROM student WHERE student_id = $1", [id])).name as string;
    const sa = (await one("SELECT body FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [t.a])).body as string;
    expect(sa).toContain('You give "Computer Networking" to ' + (await nameOf(t.b)));
    expect(sa).toContain('get "Operating Systems" from ' + (await nameOf(t.c)));
  });

  it("a chain that does not come back is not a circle (B and C want each other's book only through A)", async () => {
    const [a, b, c] = [await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    const [x, y, z] = [await makeBook(base.course), await makeBook(base.course), await makeBook(base.course)];
    const la = await makeListing(a, base.campus, x, { swap: true });
    const lb = await makeListing(b, base.campus, y, { swap: true });
    await makeListing(c, base.campus, z, { swap: true });
    await pref(a, la, y); await pref(b, lb, z); // C wants nothing
    expect(await cycles(null)).toHaveLength(0);
  });

  it("lists that are not swap-enabled, not fixed price or removed do not take part", async () => {
    const t = await circle();
    await pool.query("UPDATE listing SET open_to_swap = false WHERE listing_id = $1", [t.lb]);
    expect(await cycles(null)).toHaveLength(0);
  });
});

describe("listing availability", () => {
  for (const status of ["RESERVED", "SOLD", "SWAPPED", "REMOVED"]) {
    it(`a ${status} listing breaks the circle, and the circle comes back when it is ACTIVE again`, async () => {
      const t = await circle();
      expect(await cycles(null)).toHaveLength(1);
      await setStatus(t.lb, status);
      for (const s of [null, t.a, t.b, t.c]) expect(await cycles(s)).toHaveLength(0);
      expect(await suggestions(t.a)).toHaveLength(0);
      await setStatus(t.lb, "ACTIVE");
      expect(await cycles(null)).toHaveLength(1);
    });
  }

  it("listings in a pending swap request or proposal are not offered again", async () => {
    const t = await circle();
    await pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [[t.la, t.lb, t.lc], t.a]);
    expect(await cycles(null)).toHaveLength(0);
    const cycle = (await one("SELECT cycle_id FROM swap_request LIMIT 1")).cycle_id as string;
    await pool.query("SELECT cancel_swap_cycle($1::uuid, $2::int)", [cycle, t.a]); // called off: the listings are free again
    expect(await cycles(null)).toHaveLength(1);
  });
});

describe("duplicate matches and notifications", () => {
  it("two copies of the same book give ONE suggestion with an alternatives count, and every student is told once", async () => {
    const t = await circle();
    const lb2 = await makeListing(t.b, base.campus, t.y, { swap: true, title: "Database Systems (second copy)" });
    await pref(t.b, lb2, t.z); // the second copy wants the same book in return
    expect(await cycles(null)).toHaveLength(2); // two listing combinations ...
    const sug = await suggestions(t.a);
    expect(sug).toHaveLength(1); // ... one circle for the student
    expect(sug[0].alternatives).toBe(1);
    expect(await notify()).toBe(3);
    expect(await notify()).toBe(0);
    for (const s of [t.a, t.b, t.c]) expect(await count("SELECT 1 FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [s])).toBe(1);
    expect(lb2).toBeGreaterThan(t.lb);
  });

  it("a circle that disappears and returns (listing reserved, then active again) is not announced twice", async () => {
    const t = await circle();
    expect(await notify()).toBe(3);
    await setStatus(t.lc, "RESERVED");
    expect(await notify()).toBe(0);
    await setStatus(t.lc, "ACTIVE");
    expect(await notify()).toBe(0);
    expect(await count("SELECT 1 FROM notification WHERE type = 'SWAP_MATCH'")).toBe(3);
  });

  it("a new eligible match (a new book) is announced, and only to the students in it", async () => {
    const t = await circle();
    expect(await notify()).toBe(3);
    const d = await makeStudent(base, "D");
    const w = await makeBook(base.course);
    const ld = await makeListing(d, base.campus, w, { swap: true });
    await pref(d, ld, t.x); // D wants A's book X, and offers W; nobody wants W yet: no match
    expect(await notify()).toBe(0);
    await pref(t.a, t.la, w); // now A wants W: A <-> D is a direct swap
    expect(await notify()).toBe(2);
    expect(await count("SELECT 1 FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [t.b])).toBe(1);
    expect(await count("SELECT 1 FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [d])).toBe(1);
    expect(await count("SELECT 1 FROM notification WHERE student_id = $1 AND type = 'SWAP_MATCH'", [t.a])).toBe(2);
  });

  it("a duplicate catalogue row does not cause a second announcement of the same circle", async () => {
    const t = await circle({ wantXBook: () => makeBook(base.course, { title: "Computer Networking", author: "Kurose" }) });
    expect(await notify()).toBe(3);
    expect(await notify()).toBe(0);
  });

  it("only informs: no request, proposal or transaction is created", async () => {
    await circle();
    await notify();
    expect(await count("SELECT 1 FROM swap_request")).toBe(0);
    expect(await count("SELECT 1 FROM swap_proposal")).toBe(0);
    expect(await count("SELECT 1 FROM transactions")).toBe(0);
  });
});
