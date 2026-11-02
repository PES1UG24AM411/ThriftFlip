import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, makeAuction } from "./helpers";
import { buildListingQuery } from "../lib/listingFilters";

let base: Awaited<ReturnType<typeof setupCampus>>;
let me: number, seller: number;
beforeEach(async () => { await resetData(); base = await setupCampus(); me = await makeStudent(base, "Me"); seller = await makeStudent(base, "Seller"); });
afterAll(async () => { await pool.end(); });

// the same query the API runs
async function search(params: Record<string, string>, studentId = me): Promise<{ ids: number[]; total: number }> {
  const f = buildListingQuery(new URLSearchParams(params), studentId);
  const rows = (await pool.query(
    `SELECT d.listing_id, COUNT(*) OVER() AS total FROM v_listing_details d JOIN listing l ON l.listing_id = d.listing_id
     WHERE ${f.where.join(" AND ")} ORDER BY ${f.orderBy} LIMIT $${f.params.length + 1} OFFSET $${f.params.length + 2}`,
    [...f.params, f.pageSize, (f.page - 1) * f.pageSize])).rows;
  return { ids: rows.map((r) => r.listing_id as number), total: rows.length ? Number(rows[0].total) : 0 };
}

async function catalogue() {
  const algo = await makeBook(base.course2, { title: "Introduction to Algorithms", author: "Thomas Cormen", subject: "Algorithms" });
  const ml = await makeBook(base.course, { title: "Pattern Recognition and Machine Learning", author: "Christopher Bishop" });
  await pool.query("UPDATE book SET isbn = '9780387310732' WHERE book_id = $1", [ml]);
  const lAlgo = await makeListing(seller, base.campus, algo, { title: "Introduction to Algorithms", price: 300, cond: "GOOD", swap: true });
  const lMl = await makeListing(seller, base.campus, ml, { title: "Pattern Recognition and Machine Learning", price: 800, cond: "NEW" });
  const lGoods = await makeListing(seller, base.campus, null, { title: "Scientific calculator", price: 150, cond: "FAIR" });
  return { lAlgo, lMl, lGoods };
}

describe("search", () => {
  it("finds partial titles, partial authors and ISBNs (with or without hyphens), case-insensitively", async () => {
    const { lAlgo, lMl } = await catalogue();
    expect((await search({ q: "algo" })).ids).toEqual([lAlgo]);
    expect((await search({ q: "ALGORITHMS" })).ids).toEqual([lAlgo]);
    expect((await search({ q: "corm" })).ids).toEqual([lAlgo]);
    expect((await search({ q: "bish" })).ids).toEqual([lMl]);
    expect((await search({ q: "9780387310732" })).ids).toEqual([lMl]);
    expect((await search({ q: "978-0-387-31073-2" })).ids).toEqual([lMl]);
    expect((await search({ q: "978038731" })).ids).toEqual([lMl]); // partial ISBN
    expect((await search({ q: "machine recog" })).ids).toEqual([lMl]); // every word may match a different part
    expect((await search({ q: "zzzz" })).ids).toEqual([]);
  });

  it("wildcards typed by the user are taken literally and SQL injection attempts find nothing", async () => {
    await catalogue();
    expect((await search({ q: "%" })).ids).toEqual([]);
    expect((await search({ q: "_" })).ids).toEqual([]);
    expect((await search({ q: "'; DROP TABLE listing; --" })).ids).toEqual([]);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM listing")).rows[0].n).toBe(3);
  });
});

describe("filters combine", () => {
  it("listing type: sale, auction, swap", async () => {
    const { lAlgo, lMl, lGoods } = await catalogue();
    const auctionListing = await makeListing(seller, base.campus, null, { title: "Auctioned lamp", type: "AUCTION", price: 100 });
    await makeAuction(auctionListing, new Date(Date.now() - 60_000), new Date(Date.now() + 3_600_000));
    expect((await search({ type: "SALE" })).ids.sort()).toEqual([lAlgo, lMl, lGoods].sort());
    expect((await search({ type: "AUCTION" })).ids).toEqual([auctionListing]);
    expect((await search({ type: "SWAP" })).ids).toEqual([lAlgo]);
  });

  it("price range, condition, campus, department, semester and course code", async () => {
    const { lAlgo, lMl, lGoods } = await catalogue();
    expect((await search({ minPrice: "200", maxPrice: "500" })).ids).toEqual([lAlgo]);
    expect((await search({ minPrice: "500" })).ids).toEqual([lMl]);
    expect((await search({ maxPrice: "200" })).ids).toEqual([lGoods]);
    expect((await search({ condition: "NEW" })).ids).toEqual([lMl]);
    expect((await search({ campusId: String(base.campus) })).total).toBe(3);
    const other = (await pool.query("INSERT INTO campus (name, city) VALUES ('Other', 'X') RETURNING campus_id")).rows[0].campus_id;
    expect((await search({ campusId: String(other) })).total).toBe(0);
    expect((await search({ department: "CSE" })).ids.sort()).toEqual([lAlgo, lMl].sort());
    expect((await search({ department: "ECE" })).ids).toEqual([]);
    expect((await search({ semester: "5" })).ids).toEqual([lAlgo]);
    expect((await search({ semester: "6" })).ids).toEqual([lMl]);
    expect((await search({ courseCode: "cs200" })).ids).toEqual([lAlgo]);
  });

  it("several filters together narrow the result (AND)", async () => {
    const { lAlgo } = await catalogue();
    expect((await search({ q: "algo", type: "SWAP", condition: "GOOD", minPrice: "100", maxPrice: "400", department: "CSE", semester: "5" })).ids).toEqual([lAlgo]);
    expect((await search({ q: "algo", condition: "NEW" })).ids).toEqual([]);
    expect((await search({ q: "algo", maxPrice: "100" })).ids).toEqual([]);
  });

  it("no filters (what 'clear filters' sends) returns everything available", async () => {
    await catalogue();
    expect((await search({})).total).toBe(3);
    expect((await search({ q: "", type: "", condition: "", minPrice: "", campusId: "" })).total).toBe(3);
  });
});

describe("availability and ownership", () => {
  it("only ACTIVE listings by default; 'all' also shows reserved and sold, but never removed ones", async () => {
    const { lAlgo, lMl, lGoods } = await catalogue();
    await pool.query("UPDATE listing SET status = 'RESERVED' WHERE listing_id = $1", [lAlgo]);
    await pool.query("UPDATE listing SET status = 'SOLD' WHERE listing_id = $1", [lMl]);
    await pool.query("UPDATE listing SET status = 'REMOVED' WHERE listing_id = $1", [lGoods]);
    expect((await search({})).ids).toEqual([]);
    expect((await search({ availability: "all" })).ids.sort()).toEqual([lAlgo, lMl].sort());
  });

  it("'mine' lists my own listings only; the buyer's own and unavailable listings cannot be bought or swapped", async () => {
    const { lAlgo } = await catalogue();
    const mine = await makeListing(me, base.campus, null, { swap: true });
    expect((await search({ mine: "1" })).ids).toEqual([mine]);
    await expect(pool.query("SELECT create_purchase($1::int, $2::int)", [mine, me])).rejects.toThrow(/your own/);
    await expect(pool.query("SELECT propose_swap($1::int, $2::int, $3::int)", [me, mine, mine])).rejects.toThrow();
    await pool.query("UPDATE listing SET status = 'RESERVED' WHERE listing_id = $1", [lAlgo]);
    await expect(pool.query("SELECT create_purchase($1::int, $2::int)", [lAlgo, me])).rejects.toThrow(/not available/);
  });
});

describe("pagination and bad input", () => {
  it("pages are limited and counted", async () => {
    for (let i = 0; i < 5; i++) await makeListing(seller, base.campus, null, { title: `Item ${i}` });
    const p1 = await search({ pageSize: "2", page: "1" });
    const p3 = await search({ pageSize: "2", page: "3" });
    expect(p1.ids).toHaveLength(2);
    expect(p1.total).toBe(5);
    expect(p3.ids).toHaveLength(1);
    expect(buildListingQuery(new URLSearchParams({ pageSize: "5000" }), me).pageSize).toBe(50);
    expect(buildListingQuery(new URLSearchParams({ page: "-4", pageSize: "abc" }), me)).toMatchObject({ page: 1, pageSize: 12 });
  });

  it("invalid values give a clear 400 instead of a database error", () => {
    const bad = (p: Record<string, string>) => () => buildListingQuery(new URLSearchParams(p), me);
    expect(bad({ minPrice: "abc" })).toThrow(/Invalid value for minPrice/);
    expect(bad({ semester: "12" })).toThrow(/semester/);
    expect(bad({ campusId: "1.5" })).toThrow(/campusId/);
    expect(bad({ minPrice: "500", maxPrice: "100" })).toThrow(/minimum price/);
    expect(bad({ type: "BARTER" })).toThrow(/listing type/);
    expect(bad({ condition: "BROKEN" })).toThrow(/condition/);
  });
});
