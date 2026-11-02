import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, move, one } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
let seller: number, buyer: number, listing: number;

beforeEach(async () => {
  await resetData();
  base = await setupCampus();
  seller = await makeStudent(base, "Seller");
  buyer = await makeStudent(base, "Buyer");
  listing = await makeListing(seller, base.campus, await makeBook(base.course), { price: 250 });
});
afterAll(async () => { await pool.end(); });

const buy = async (who = buyer) => (await pool.query("SELECT create_purchase($1::int, $2::int) AS id", [listing, who])).rows[0].id as number;
const stateOf = async (tx: number) => (await one("SELECT state FROM transactions WHERE transaction_id = $1", [tx])).state;

describe("purchase", () => {
  it("creates a PENDING transaction with the listing price and reserves the listing", async () => {
    const tx = await buy();
    const t = await one("SELECT * FROM transactions WHERE transaction_id = $1", [tx]);
    expect(t).toMatchObject({ buyer_id: buyer, seller_id: seller, state: "PENDING", transaction_type: "PURCHASE" });
    expect(Number(t.amount)).toBe(250);
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("RESERVED");
  });

  it("rejects buying your own listing, an unavailable listing and an auction listing", async () => {
    await expect(buy(seller)).rejects.toThrow(/own listing/);
    await buy();
    await expect(buy(await makeStudent(base))).rejects.toThrow(/not available/);
    const auctionListing = await makeListing(seller, base.campus, null, { type: "AUCTION" });
    await expect(pool.query("SELECT create_purchase($1::int, $2::int)", [auctionListing, buyer])).rejects.toThrow(/bidding/);
  });

  it("two buyers at the same time: exactly one succeeds", async () => {
    const other = await makeStudent(base);
    const results = await Promise.allSettled([buy(buyer), buy(other)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describe("state machine", () => {
  it("walks PENDING -> PAYMENT_HELD -> HANDED_OFF -> CONFIRMED -> RELEASED and marks the listing SOLD", async () => {
    const tx = await buy();
    for (const s of ["PAYMENT_HELD", "HANDED_OFF", "CONFIRMED", "RELEASED"]) {
      await move(tx, s);
      expect(await stateOf(tx)).toBe(s);
    }
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("SOLD");
  });

  it("rejects skipped states and moves out of final states", async () => {
    const tx = await buy();
    await expect(move(tx, "RELEASED")).rejects.toThrow(/Invalid transaction state change: PENDING -> RELEASED/);
    await expect(move(tx, "HANDED_OFF")).rejects.toThrow(/Invalid/);
    await expect(move(tx, "CONFIRMED")).rejects.toThrow(/Invalid/);
    for (const s of ["PAYMENT_HELD", "HANDED_OFF", "CONFIRMED", "RELEASED"]) await move(tx, s);
    await expect(move(tx, "CANCELLED")).rejects.toThrow(/Invalid/);
    await expect(move(tx, "PENDING")).rejects.toThrow(/Invalid/);
  });

  it("rejects invalid moves even with a plain UPDATE (enforced by the trigger, not the API)", async () => {
    const tx = await buy();
    await expect(pool.query("UPDATE transactions SET state = 'CONFIRMED' WHERE transaction_id = $1", [tx])).rejects.toThrow(/Invalid transaction state change/);
    expect(await stateOf(tx)).toBe("PENDING");
  });

  it("writes TRANSACTION_STATE_HISTORY with previous state, new state and actor", async () => {
    const tx = await buy();
    await move(tx, "PAYMENT_HELD", "STUDENT", buyer);
    await move(tx, "HANDED_OFF", "STUDENT", seller);
    const h = (await pool.query("SELECT * FROM transaction_state_history WHERE transaction_id = $1 ORDER BY history_id", [tx])).rows;
    expect(h.map((r) => [r.previous_state, r.new_state])).toEqual([[null, "PENDING"], ["PENDING", "PAYMENT_HELD"], ["PAYMENT_HELD", "HANDED_OFF"]]);
    expect(h[1]).toMatchObject({ changed_by_type: "STUDENT", changed_by_id: buyer });
    expect(h[2]).toMatchObject({ changed_by_type: "STUDENT", changed_by_id: seller });
    expect(h[0].changed_by_type).toBe("SYSTEM");
  });

  it("a cancelled purchase frees the listing again", async () => {
    const tx = await buy();
    await move(tx, "CANCELLED");
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("ACTIVE");
    await buy(await makeStudent(base)); // can be bought again
  });
});

describe("offers", () => {
  it("accepting one offer opens a transaction at that price and rejects the others", async () => {
    const other = await makeStudent(base);
    const o1 = (await one("INSERT INTO offer (listing_id, buyer_id, amount) VALUES ($1, $2, 200) RETURNING offer_id", [listing, buyer])).offer_id;
    const o2 = (await one("INSERT INTO offer (listing_id, buyer_id, amount) VALUES ($1, $2, 220) RETURNING offer_id", [listing, other])).offer_id;
    await expect(pool.query("SELECT accept_offer($1::int, $2::int)", [o1, buyer])).rejects.toThrow(/Only the seller/);
    const tx = (await pool.query("SELECT accept_offer($1::int, $2::int) AS id", [o2, seller])).rows[0].id;
    expect(Number((await one("SELECT amount FROM transactions WHERE transaction_id = $1", [tx])).amount)).toBe(220);
    expect((await one("SELECT status FROM offer WHERE offer_id = $1", [o1])).status).toBe("REJECTED");
  });
});
