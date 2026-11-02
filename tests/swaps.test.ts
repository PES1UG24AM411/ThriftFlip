import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, one } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const pref = (student: number, listing: number, wantedBook: number) =>
  pool.query("INSERT INTO swap_preference (student_id, offered_listing_id, wanted_book_id) VALUES ($1, $2, $3)", [student, listing, wantedBook]);
const cycles = async (student: number | null = null, max = 4) =>
  (await pool.query("SELECT * FROM find_swap_cycles($1::int, $2::int)", [student, max])).rows;

// n students; student i offers book i and wants book i+1 (the last one wants book 0) -> one cycle of length n
async function ring(n: number) {
  const students: number[] = [];
  const books: number[] = [];
  const listings: number[] = [];
  for (let i = 0; i < n; i++) {
    students.push(await makeStudent(base, `S${i}`));
    books.push(await makeBook(base.course, { title: `Ring book ${i}` }));
  }
  for (let i = 0; i < n; i++) listings.push(await makeListing(students[i], base.campus, books[i], { swap: true }));
  for (let i = 0; i < n; i++) await pref(students[i], listings[i], books[(i + 1) % n]);
  return { students, books, listings };
}

describe("swap matching", () => {
  it("detects a direct swap (A wants B's book, B wants A's book)", async () => {
    const { students, listings } = await ring(2);
    const found = await cycles();
    expect(found).toHaveLength(1);
    expect(found[0].swap_type).toBe("DIRECT");
    expect(found[0].listing_ids).toEqual(listings);
    expect([...found[0].student_ids].sort()).toEqual([...students].sort());
  });

  it("detects a three-way cycle (A wants B, B wants C, C wants A)", async () => {
    const { students } = await ring(3);
    const found = await cycles();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ swap_type: "MULTI_WAY", cycle_length: 3 });
    expect(await cycles(students[1])).toHaveLength(1);
    expect(await cycles(await makeStudent(base))).toHaveLength(0); // an uninvolved student sees nothing
  });

  it("finds no match when the chain does not close or an item is unavailable", async () => {
    const a = await makeStudent(base), b = await makeStudent(base);
    const bookA = await makeBook(base.course), bookB = await makeBook(base.course);
    const la = await makeListing(a, base.campus, bookA, { swap: true });
    await makeListing(b, base.campus, bookB, { swap: true });
    await pref(a, la, bookB); // A wants B's book, B wants nothing
    expect(await cycles()).toHaveLength(0);
    const r = await ring(2);
    await pool.query("UPDATE listing SET status = 'RESERVED' WHERE listing_id = $1", [r.listings[0]]);
    expect(await cycles()).toHaveLength(0);
  });

  it("respects the maximum cycle length", async () => {
    await ring(4);
    expect(await cycles(null, 3)).toHaveLength(0);
    expect(await cycles(null, 4)).toHaveLength(1);
  });

  it("a preference can only offer a listing the student owns", async () => {
    const a = await makeStudent(base), b = await makeStudent(base);
    const book = await makeBook(base.course);
    const lb = await makeListing(b, base.campus, book, { swap: true });
    await expect(pref(a, lb, book)).rejects.toThrow(/own/);
  });
});

describe("proposing and answering swaps", () => {
  it("direct swap: both accept -> two SWAP transactions and reserved listings", async () => {
    const { students, listings } = await ring(2);
    const cycle = (await pool.query("SELECT propose_swap_cycle($1::int[], $2::int) AS id", [listings, students[0]])).rows[0].id;
    const reqs = (await pool.query("SELECT * FROM swap_request WHERE cycle_id = $1 ORDER BY swap_request_id", [cycle])).rows;
    expect(reqs).toHaveLength(2);
    // the initiator already agreed to give away their own listing
    expect(reqs.filter((r) => r.status === "ACCEPTED")).toHaveLength(1);
    const pending = reqs.find((r) => r.status === "PENDING")!;
    const result = (await pool.query("SELECT respond_swap_request($1::int, $2::int, true) AS r", [pending.swap_request_id, students[1]])).rows[0].r;
    expect(result).toBe("READY");
    const txs = (await pool.query("SELECT * FROM transactions WHERE transaction_type = 'SWAP'")).rows;
    expect(txs).toHaveLength(2);
    expect(txs.every((t) => Number(t.amount) === 0)).toBe(true);
    expect((await one("SELECT COUNT(*)::int AS n FROM listing WHERE status = 'RESERVED'")).n).toBe(2);
  });

  it("three-way swap needs all three answers", async () => {
    const { students, listings } = await ring(3);
    await pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [listings, students[0]]);
    const answer = async (owner: number) => {
      const req = await one(
        `SELECT r.swap_request_id FROM swap_request r JOIN listing l ON l.listing_id = r.requested_listing_id
         WHERE l.seller_id = $1 AND r.status = 'PENDING'`, [owner]);
      return (await pool.query("SELECT respond_swap_request($1::int, $2::int, true) AS r", [req.swap_request_id, owner])).rows[0].r;
    };
    expect(await answer(students[1])).toBe("WAITING");
    expect(await answer(students[2])).toBe("READY");
    expect((await one("SELECT COUNT(*)::int AS n FROM transactions WHERE transaction_type = 'SWAP'")).n).toBe(3);
  });

  it("a rejection cancels the whole cycle and nothing is reserved", async () => {
    const { students, listings } = await ring(3);
    await pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [listings, students[0]]);
    const req = await one(
      `SELECT r.swap_request_id FROM swap_request r JOIN listing l ON l.listing_id = r.requested_listing_id
       WHERE l.seller_id = $1`, [students[1]]);
    expect((await pool.query("SELECT respond_swap_request($1::int, $2::int, false) AS r", [req.swap_request_id, students[1]])).rows[0].r).toBe("REJECTED");
    expect((await one("SELECT COUNT(*)::int AS n FROM swap_request WHERE status IN ('PENDING','ACCEPTED')")).n).toBe(0);
    expect((await one("SELECT COUNT(*)::int AS n FROM listing WHERE status = 'RESERVED'")).n).toBe(0);
  });

  it("validates ownership, availability, duplicates and conflicts", async () => {
    const { students, listings } = await ring(2);
    const stranger = await makeStudent(base);
    await expect(pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [listings, stranger])).rejects.toThrow(/own one of the listings/);
    await expect(pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [[listings[0]], students[0]])).rejects.toThrow(/between 2 and 6/);
    await expect(pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [[listings[0], listings[0]], students[0]])).rejects.toThrow(/twice/);
    await pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [listings, students[0]]);
    await expect(pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [listings, students[1]])).rejects.toThrow(/already part of another swap/);
  });

  it("only the owner of the requested listing may answer", async () => {
    const { students, listings } = await ring(2);
    await pool.query("SELECT propose_swap_cycle($1::int[], $2::int)", [listings, students[0]]);
    const req = await one("SELECT swap_request_id FROM swap_request WHERE status = 'PENDING'");
    await expect(pool.query("SELECT respond_swap_request($1::int, $2::int, true)", [req.swap_request_id, students[0]])).rejects.toThrow(/Only the owner/);
  });
});
