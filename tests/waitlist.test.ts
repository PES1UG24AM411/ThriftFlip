// The waitlist FEATURE was removed in migration 018: join_waitlist / claim_waitlist / expire_waitlist_claims /
// notify_next_waitlist and the view v_waitlist_queue are dropped. The old `waitlist` TABLE and its rows are kept on purpose
// (nothing is deleted), and cancelling a purchase now simply makes the listing available again.
// (The earlier tests here called the dropped functions and could only fail.)
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, move, one } from "./helpers";

beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await pool.end();
});

describe("waitlist (removed feature, old data kept)", () => {
  it("keeps the old waitlist table", async () => {
    expect((await one("SELECT to_regclass('public.waitlist') IS NOT NULL AS present")).present).toBe(true);
  });

  it("no longer has the waitlist functions or the queue view", async () => {
    const r = await one(
      `SELECT to_regproc('join_waitlist') IS NULL AS no_join, to_regproc('claim_waitlist') IS NULL AS no_claim,
              to_regproc('expire_waitlist_claims') IS NULL AS no_expire, to_regclass('public.v_waitlist_queue') IS NULL AS no_view`
    );
    expect(r).toEqual({ no_join: true, no_claim: true, no_expire: true, no_view: true });
  });

  it("a cancelled purchase makes the listing available again (no waitlist step)", async () => {
    const base = await setupCampus();
    const seller = await makeStudent(base, "Seller");
    const buyer = await makeStudent(base, "Buyer");
    const listing = await makeListing(seller, base.campus, await makeBook(base.course), { price: 300 });
    const tx = (await one("SELECT create_purchase($1::int, $2::int) AS id", [listing, buyer])).id as number;
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("RESERVED");
    await move(tx, "CANCELLED");
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("ACTIVE");
  });
});
