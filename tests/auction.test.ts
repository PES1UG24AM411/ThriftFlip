import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, makeAuction, placeBid, one, SEC, MIN, HOUR, DAY } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
let seller: number, alice: number, bob: number, auction: number, listing: number;
let start: Date, end: Date;

beforeEach(async () => {
  await resetData();
  base = await setupCampus();
  seller = await makeStudent(base, "Seller");
  alice = await makeStudent(base, "Alice");
  bob = await makeStudent(base, "Bob");
  const book = await makeBook(base.course);
  listing = await makeListing(seller, base.campus, book, { type: "AUCTION", price: 100 });
  start = new Date(Date.now() - HOUR);
  end = new Date(Date.now() + HOUR);
  auction = await makeAuction(listing, start, end, 10);
});
afterAll(async () => { await pool.end(); });

const state = () => one("SELECT * FROM auction WHERE auction_id = $1", [auction]);

describe("bid validation", () => {
  it("accepts a first bid at the starting price and updates price and highest bidder", async () => {
    await placeBid(auction, alice, 100);
    const a = await state();
    expect(Number(a.current_price)).toBe(100);
    expect(a.highest_bidder_id).toBe(alice);
  });

  it("rejects a first bid below the starting price", async () => {
    await expect(placeBid(auction, alice, 99)).rejects.toThrow(/at least/);
  });

  it("enforces the minimum increment over the current price", async () => {
    await placeBid(auction, alice, 100);
    await expect(placeBid(auction, bob, 105)).rejects.toThrow(/at least 110/);
    await placeBid(auction, bob, 110);
    expect((await state()).highest_bidder_id).toBe(bob);
  });

  it("rejects the seller, unknown auctions, bids before the start and after the end", async () => {
    await expect(placeBid(auction, seller, 100)).rejects.toThrow(/Sellers cannot bid/);
    await expect(placeBid(9999, alice, 100)).rejects.toThrow(/not found/);
    await expect(placeBid(auction, alice, 100, new Date(start.getTime() - MIN))).rejects.toThrow(/not started/);
    await expect(placeBid(auction, alice, 100, new Date(end.getTime() + SEC))).rejects.toThrow(/ended/);
  });

  it("rejects suspended bidders and direct inserts that skip place_bid", async () => {
    await pool.query("UPDATE student SET status = 'SUSPENDED' WHERE student_id = $1", [alice]);
    await expect(placeBid(auction, alice, 100)).rejects.toThrow(/Suspended/);
    await expect(pool.query("INSERT INTO bid (auction_id, bidder_id, amount) VALUES ($1, $2, 1)", [auction, bob])).rejects.toThrow(/at least/);
  });

  it("notifies the previous highest bidder when outbid", async () => {
    await placeBid(auction, alice, 100);
    await placeBid(auction, bob, 120);
    const n = await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'OUTBID'", [alice]);
    expect(n.n).toBe(1);
  });

  it("a bidder can cancel an old bid but not the highest one", async () => {
    await placeBid(auction, alice, 100);
    await placeBid(auction, bob, 120);
    const aliceBid = (await one("SELECT bid_id FROM bid WHERE bidder_id = $1", [alice])).bid_id;
    const bobBid = (await one("SELECT bid_id FROM bid WHERE bidder_id = $1", [bob])).bid_id;
    await expect(pool.query("SELECT cancel_bid($1::int, $2::int)", [bobBid, bob])).rejects.toThrow(/highest/);
    await pool.query("SELECT cancel_bid($1::int, $2::int)", [aliceBid, alice]);
    expect((await one("SELECT status FROM bid WHERE bid_id = $1", [aliceBid])).status).toBe("CANCELLED");
  });
});

describe("anti-sniping", () => {
  it("a bid in the last 60 seconds extends the deadline by 2 minutes", async () => {
    const r = await placeBid(auction, alice, 100, new Date(end.getTime() - 30 * SEC));
    expect(r.rows[0].out_extended).toBe(true);
    const a = await state();
    expect(new Date(a.end_time).getTime()).toBe(end.getTime() + 2 * MIN);
    expect(a.extension_count).toBe(1);
    expect(new Date(a.original_end_time).getTime()).toBe(end.getTime());
  });

  it("a bid earlier than 60 seconds before the end does not extend it", async () => {
    const r = await placeBid(auction, alice, 100, new Date(end.getTime() - 5 * MIN));
    expect(r.rows[0].out_extended).toBe(false);
    expect(new Date((await state()).end_time).getTime()).toBe(end.getTime());
  });

  it("the extended deadline accepts later bids and sniping can repeat", async () => {
    await placeBid(auction, alice, 100, new Date(end.getTime() - 30 * SEC));
    const r = await placeBid(auction, bob, 110, new Date(end.getTime() + 90 * SEC)); // after the old end, inside the new one
    expect(r.rows[0].out_extended).toBe(true);
    expect((await state()).extension_count).toBe(2);
  });
});

describe("concurrency", () => {
  it("two simultaneous equal bids: exactly one wins (row lock + increment rule)", async () => {
    const results = await Promise.allSettled([placeBid(auction, alice, 100), placeBid(auction, bob, 100)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await one("SELECT COUNT(*)::int AS n FROM bid WHERE auction_id = $1", [auction])).n).toBe(1);
  });

  it("many simultaneous bids keep the highest bid consistent", async () => {
    const bidders = await Promise.all([1, 2, 3, 4].map(() => makeStudent(base, "Racer")));
    await Promise.allSettled(bidders.map((b, i) => placeBid(auction, b, 100 + i * 10)));
    const a = await state();
    const top = await one("SELECT MAX(amount) AS m FROM bid WHERE auction_id = $1", [auction]);
    expect(Number(a.current_price)).toBe(Number(top.m));
  });
});

describe("closing and winner selection", () => {
  it("cannot close before the end time", async () => {
    await expect(pool.query("SELECT close_auction($1::int)", [auction])).rejects.toThrow(/not ended/);
  });

  it("closes after the end: winner = highest bidder, AUCTION_WIN transaction, listing reserved, closing twice is harmless", async () => {
    await placeBid(auction, alice, 100);
    await placeBid(auction, bob, 150);
    const after = new Date(end.getTime() + MIN);
    const tx = (await pool.query("SELECT close_auction($1::int, $2::timestamptz) AS id", [auction, after])).rows[0].id;
    const a = await state();
    expect(a.status).toBe("CLOSED");
    expect(a.winner_id).toBe(bob);
    const t = await one("SELECT * FROM transactions WHERE transaction_id = $1", [tx]);
    expect(t).toMatchObject({ buyer_id: bob, seller_id: seller, transaction_type: "AUCTION_WIN", state: "PENDING" });
    expect(Number(t.amount)).toBe(150);
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("RESERVED");
    expect((await pool.query("SELECT close_auction($1::int, $2::timestamptz) AS id", [auction, after])).rows[0].id).toBeNull();
    await expect(placeBid(auction, alice, 500)).rejects.toThrow(/not open|ended/);
  });

  it("an auction without bids closes without a winner and withdraws the listing", async () => {
    const after = new Date(end.getTime() + MIN);
    expect((await pool.query("SELECT close_auction($1::int, $2::timestamptz) AS id", [auction, after])).rows[0].id).toBeNull();
    expect((await state()).winner_id).toBeNull();
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("REMOVED");
  });

  it("close_expired_auctions closes only finished auctions", async () => {
    const b2 = await makeBook(base.course);
    const l2 = await makeListing(seller, base.campus, b2, { type: "AUCTION", price: 50 });
    const a2 = await makeAuction(l2, new Date(Date.now() - 2 * DAY), new Date(Date.now() - DAY));
    const n = (await pool.query("SELECT close_expired_auctions() AS n")).rows[0].n;
    expect(n).toBe(1);
    expect((await one("SELECT status FROM auction WHERE auction_id = $1", [a2])).status).toBe("CLOSED");
    expect((await state()).status).toBe("ACTIVE");
  });
});
