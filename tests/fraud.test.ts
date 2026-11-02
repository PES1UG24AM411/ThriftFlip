import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, makeAuction, placeBid, one, SEC, HOUR, DAY } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const risk = (bidder: number) => one("SELECT * FROM v_bid_risk WHERE bidder_id = $1", [bidder]);

// Past auction with an honest first bid, then optional burst bids by `bidder`.
async function pastAuction(seller: number, daysAgo: number, honest: number, burst: number | null) {
  const book = await makeBook(base.course);
  const listing = await makeListing(seller, base.campus, book, { type: "AUCTION", price: 100 });
  const end = new Date(Date.now() - daysAgo * DAY);
  const a = await makeAuction(listing, new Date(end.getTime() - 2 * DAY), end, 20);
  await placeBid(a, honest, 100, new Date(end.getTime() - 6 * HOUR));
  if (burst) {
    await placeBid(a, burst, 200, new Date(end.getTime() - 50 * SEC)); // last minute + jump
    await placeBid(a, burst, 300, new Date(end.getTime() - 40 * SEC)); // rapid + jump
    await placeBid(a, burst, 400, new Date(end.getTime() - 30 * SEC)); // rapid + jump
  }
}

describe("suspicious bidding analysis (v_bid_risk)", () => {
  it("classifies a normal bidder as NORMAL", async () => {
    const seller = await makeStudent(base);
    const honest = await makeStudent(base);
    await pastAuction(seller, 3, honest, null);
    expect(await risk(honest)).toMatchObject({ risk_level: "NORMAL", risk_score: 0, total_bids: 1 });
  });

  it("flags rapid last-minute bursts repeated on one seller as HIGH_RISK", async () => {
    const seller = await makeStudent(base);
    const honest = await makeStudent(base);
    const shill = await makeStudent(base);
    for (const days of [3, 2, 1]) await pastAuction(seller, days, honest, shill);
    const r = await risk(shill);
    expect(r.rapid_bids).toBe(6);       // 2 per auction
    expect(r.last_minute_bids).toBe(3); // 1 per auction
    expect(r.jump_bids).toBe(9);
    expect(r.auctions_bid_on).toBe(3);
    expect(r.risk_level).toBe("HIGH_RISK");
    expect(r.risk_score).toBeGreaterThanOrEqual(15);
    expect((await risk(honest)).risk_level).toBe("NORMAL");
  });

  it("flags repeated last-minute bids on the same seller as SUSPICIOUS (score 7)", async () => {
    const seller = await makeStudent(base);
    const honest = await makeStudent(base);
    const sniper = await makeStudent(base);
    for (const days of [4, 2]) {
      const book = await makeBook(base.course);
      const listing = await makeListing(seller, base.campus, book, { type: "AUCTION", price: 100 });
      const end = new Date(Date.now() - days * DAY);
      const a = await makeAuction(listing, new Date(end.getTime() - 2 * DAY), end, 10);
      await placeBid(a, honest, 100, new Date(end.getTime() - 5 * HOUR));
      await placeBid(a, sniper, 110, new Date(end.getTime() - 40 * SEC));
    }
    expect(await risk(sniper)).toMatchObject({ risk_score: 7, risk_level: "SUSPICIOUS" });
  });

  it("results come from the data: cancelling bids does not hide the pattern", async () => {
    const seller = await makeStudent(base);
    const honest = await makeStudent(base);
    const shill = await makeStudent(base);
    await pastAuction(seller, 2, honest, shill);
    const before = (await risk(shill)).risk_score;
    await pool.query("UPDATE bid SET status = 'CANCELLED' WHERE bidder_id = $1 AND amount < 400", [shill]);
    expect((await risk(shill)).risk_score).toBe(before);
  });
});
