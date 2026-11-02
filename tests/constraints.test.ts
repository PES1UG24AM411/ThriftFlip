import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, one, DAY } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const CHECK = { code: "23514" };

describe("CHECK / UNIQUE / FK constraints reject bad data", () => {
  it("student: bad SRN format", async () => {
    await expect(pool.query(
      `INSERT INTO student (srn, name, email, password_hash, department_id, semester)
       VALUES ('abc', 'X', 'x@test.local', $1, $2, 1)`, ["h".repeat(60), base.dept]
    )).rejects.toMatchObject(CHECK);
  });

  it("listing: price must be positive, status and condition must be valid, textbook needs a book", async () => {
    const s = await makeStudent(base);
    const b = await makeBook(base.course);
    await expect(makeListing(s, base.campus, b, { price: 0 })).rejects.toMatchObject(CHECK);
    await expect(makeListing(s, base.campus, b, { price: -5 })).rejects.toMatchObject(CHECK);
    await expect(makeListing(s, base.campus, b, { cond: "BROKEN" })).rejects.toMatchObject(CHECK);
    await expect(pool.query(
      "INSERT INTO listing (seller_id, campus_id, category, title, item_condition, price) VALUES ($1, $2, 'TEXTBOOK', 'No book', 'GOOD', 10)", [s, base.campus]
    )).rejects.toMatchObject(CHECK);
    const l = await makeListing(s, base.campus, b);
    await expect(pool.query("UPDATE listing SET status = 'NOPE' WHERE listing_id = $1", [l])).rejects.toMatchObject(CHECK);
  });

  it("auction: end must be after start; only AUCTION listings can have auctions", async () => {
    const s = await makeStudent(base);
    const l = await makeListing(s, base.campus, null, { type: "AUCTION" });
    const now = Date.now();
    await expect(pool.query(
      "INSERT INTO auction (listing_id, starting_price, start_time, end_time) VALUES ($1, 100, $2, $3)", [l, new Date(now + DAY), new Date(now)]
    )).rejects.toMatchObject(CHECK);
    const fixed = await makeListing(s, base.campus, null);
    await expect(pool.query(
      "INSERT INTO auction (listing_id, starting_price, start_time, end_time) VALUES ($1, 100, $2, $3)", [fixed, new Date(now), new Date(now + DAY)]
    )).rejects.toMatchObject(CHECK);
  });

  it("wishlist: no duplicate entry", async () => {
    const s = await makeStudent(base);
    const buyer = await makeStudent(base);
    const l = await makeListing(s, base.campus, null);
    await pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2)", [buyer, l]);
    await expect(pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2)", [buyer, l])).rejects.toMatchObject({ code: "23505" });
  });

  it("transactions: invalid state, buyer = seller, one active transaction per listing", async () => {
    const seller = await makeStudent(base);
    const buyer = await makeStudent(base);
    const l = await makeListing(seller, base.campus, null);
    await expect(pool.query("INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, state) VALUES ($1, $2, $3, 10, 'DONE')", [l, buyer, seller])).rejects.toMatchObject(CHECK);
    await expect(pool.query("INSERT INTO transactions (listing_id, buyer_id, seller_id, amount) VALUES ($1, $2, $2, 10)", [l, seller])).rejects.toMatchObject(CHECK);
    await pool.query("INSERT INTO transactions (listing_id, buyer_id, seller_id, amount) VALUES ($1, $2, $3, 10)", [l, buyer, seller]);
    await expect(pool.query("INSERT INTO transactions (listing_id, buyer_id, seller_id, amount) VALUES ($1, $2, $3, 10)", [l, buyer, seller])).rejects.toMatchObject({ code: "23505" });
  });

  it("rating: score 1-5, only after a completed transaction, only by the two parties, once per rater", async () => {
    const seller = await makeStudent(base);
    const buyer = await makeStudent(base);
    const other = await makeStudent(base);
    const l = await makeListing(seller, base.campus, null);
    const tx = (await one("INSERT INTO transactions (listing_id, buyer_id, seller_id, amount) VALUES ($1, $2, $3, 10) RETURNING transaction_id", [l, buyer, seller])).transaction_id;
    const rate = (rater: number, ratee: number, score: number) =>
      pool.query("INSERT INTO rating (transaction_id, rater_id, ratee_id, score) VALUES ($1, $2, $3, $4)", [tx, rater, ratee, score]);
    await expect(rate(buyer, seller, 5)).rejects.toMatchObject(CHECK); // still PENDING
    await pool.query("UPDATE transactions SET state = 'PAYMENT_HELD' WHERE transaction_id = $1", [tx]);
    await pool.query("UPDATE transactions SET state = 'HANDED_OFF' WHERE transaction_id = $1", [tx]);
    await pool.query("UPDATE transactions SET state = 'CONFIRMED' WHERE transaction_id = $1", [tx]);
    await expect(rate(buyer, seller, 5)).rejects.toMatchObject(CHECK); // CONFIRMED is not finished yet: only RELEASED can be rated
    await pool.query("UPDATE transactions SET state = 'RELEASED' WHERE transaction_id = $1", [tx]);
    await expect(rate(buyer, seller, 6)).rejects.toMatchObject(CHECK);
    await expect(rate(buyer, buyer, 5)).rejects.toMatchObject(CHECK); // no self-rating
    await expect(rate(other, seller, 5)).rejects.toMatchObject(CHECK);
    await rate(buyer, seller, 5);
    await expect(rate(buyer, seller, 4)).rejects.toMatchObject({ code: "23505" });
  });

  it("report: needs a target and cannot target yourself; foreign keys are enforced", async () => {
    const a = await makeStudent(base);
    await expect(pool.query("INSERT INTO report (reporter_id, reason) VALUES ($1, 'SPAM')", [a])).rejects.toMatchObject(CHECK);
    await expect(pool.query("INSERT INTO report (reporter_id, reported_student_id, reason) VALUES ($1, $1, 'SPAM')", [a])).rejects.toMatchObject(CHECK);
    await expect(pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, 9999)", [a])).rejects.toMatchObject({ code: "23503" });
  });
});
