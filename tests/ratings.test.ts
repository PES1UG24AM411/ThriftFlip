import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeListing, one, completeSale } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const summary = (id: number) => one("SELECT * FROM v_student_ratings WHERE student_id = $1", [id]);
const rate = (tx: number, rater: number, ratee: number, score: number) =>
  pool.query("INSERT INTO rating (transaction_id, rater_id, ratee_id, score) VALUES ($1, $2, $3, $4) RETURNING rating_id", [tx, rater, ratee, score]);
const sale = async (seller: number, buyer: number, state = "RELEASED") => completeSale(await makeListing(seller, base.campus, null), buyer, state);
const makeAdmin = async () => (await one("INSERT INTO admin (name, email, password_hash) VALUES ('A', 'a@t.local', $1) RETURNING admin_id", ["h".repeat(60)])).admin_id;

describe("ratings and reviews (no reputation score)", () => {
  it("a new student is 'not rated yet': no average, no ratings", async () => {
    const s = await makeStudent(base);
    expect(await summary(s)).toMatchObject({ rating_count: 0, completed_transactions: 0 });
    expect((await summary(s)).avg_rating).toBeNull();
  });

  it("the old reputation view is gone", async () => {
    const r = await pool.query("SELECT to_regclass('v_student_reputation') AS v");
    expect(r.rows[0].v).toBeNull();
  });

  it("average and count come from ratings of finished deals only", async () => {
    const seller = await makeStudent(base), b1 = await makeStudent(base), b2 = await makeStudent(base);
    await rate(await sale(seller, b1), b1, seller, 5);
    await rate(await sale(seller, b2), b2, seller, 4);
    expect(await summary(seller)).toMatchObject({ rating_count: 2, completed_sales: 2 });
    expect(Number((await summary(seller)).avg_rating)).toBe(4.5);
  });

  it("only RELEASED deals can be rated, and only once per person", async () => {
    const seller = await makeStudent(base), buyer = await makeStudent(base), other = await makeStudent(base);
    const open = await sale(seller, buyer, "CONFIRMED");
    await expect(rate(open, buyer, seller, 5)).rejects.toMatchObject({ code: "23514" });
    const done = await sale(seller, buyer);
    await rate(done, buyer, seller, 4);
    await expect(rate(done, buyer, seller, 5)).rejects.toMatchObject({ code: "23505" }); // duplicate
    await expect(rate(done, other, seller, 5)).rejects.toMatchObject({ code: "23514" }); // not part of the deal
    await expect(rate(done, buyer, buyer, 5)).rejects.toMatchObject({ code: "23514" }); // self
  });

  it("the listing view shows the seller's average rating", async () => {
    const seller = await makeStudent(base), buyer = await makeStudent(base);
    const l = await makeListing(seller, base.campus, null);
    expect((await one("SELECT seller_avg_rating, seller_rating_count FROM v_listing_details WHERE listing_id = $1", [l])).seller_avg_rating).toBeNull();
    await rate(await sale(seller, buyer), buyer, seller, 3);
    expect(await one("SELECT seller_rating_count FROM v_listing_details WHERE listing_id = $1", [l])).toMatchObject({ seller_rating_count: 1 });
  });

  it("an admin can hide a review: the text is hidden, the stars still count, and the author is told why", async () => {
    const admin = await makeAdmin();
    const seller = await makeStudent(base), buyer = await makeStudent(base);
    const rid = (await rate(await sale(seller, buyer), buyer, seller, 2)).rows[0].rating_id;
    const review = (await one("INSERT INTO review (rating_id, body) VALUES ($1, 'rude text') RETURNING review_id", [rid])).review_id;
    await expect(pool.query("SELECT admin_take_action($1::int, 'HIDE_REVIEW', 'ab', NULL, NULL, $2::int)", [admin, review])).rejects.toThrow(/reason/);
    await pool.query("SELECT admin_take_action($1::int, 'HIDE_REVIEW', 'Abusive language', NULL, NULL, $2::int)", [admin, review]);
    expect((await one("SELECT is_hidden, hidden_reason FROM review WHERE review_id = $1", [review]))).toMatchObject({ is_hidden: true, hidden_reason: "Abusive language" });
    expect((await summary(seller)).rating_count).toBe(1);
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'ADMIN_MESSAGE'", [buyer])).n).toBe(1);
    await pool.query("SELECT admin_take_action($1::int, 'RESTORE_REVIEW', 'Looked again, it is fine', NULL, NULL, $2::int)", [admin, review]);
    expect((await one("SELECT is_hidden FROM review WHERE review_id = $1", [review])).is_hidden).toBe(false);
  });
});

describe("wanted books on swap listings", () => {
  it("a listing can have catalogue or typed wanted books, no duplicates, at most 5", async () => {
    const seller = await makeStudent(base);
    const l = await makeListing(seller, base.campus, null);
    const add = (t: string) => pool.query("INSERT INTO listing_wanted_book (listing_id, custom_title) VALUES ($1, $2)", [l, t]);
    for (let i = 1; i <= 4; i++) await add(`Book ${i}`);
    await expect(add(" book 1 ")).rejects.toMatchObject({ code: "23505" }); // duplicate
    await add("Book 5");
    await expect(add("Book 6")).rejects.toThrow(/at most 5/);
    expect((await one("SELECT wanted_books FROM v_listing_details WHERE listing_id = $1", [l])).wanted_books).toBe("Book 1 | Book 2 | Book 3 | Book 4 | Book 5");
  });
});
