import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, one } from "./helpers";
import { swapActionsFor } from "../lib/swaps";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

// Alice owns A (open to swap), Bob owns B (open to swap)
async function pair() {
  const alice = await makeStudent(base, "Alice"), bob = await makeStudent(base, "Bob");
  const a = await makeListing(alice, base.campus, await makeBook(base.course), { swap: true, title: "A" });
  const b = await makeListing(bob, base.campus, await makeBook(base.course), { swap: true, title: "B" });
  return { alice, bob, a, b };
}
const propose = (by: number, offered: number, requested: number, amount = 0, payer: string | null = null) =>
  pool.query("SELECT propose_swap($1::int, $2::int, $3::int, $4::numeric, $5::text, NULL) AS id", [by, offered, requested, amount, payer]).then((r) => r.rows[0].id as number);
const respond = (id: number, who: number, action: string) =>
  pool.query("SELECT respond_swap_proposal($1::int, $2::int, $3::text) AS r", [id, who, action]).then((r) => r.rows[0].r as string);
const confirmEx = (id: number, who: number) =>
  pool.query("SELECT confirm_swap_exchange($1::int, $2::int) AS r", [id, who]).then((r) => r.rows[0].r as string);
const status = async (id: number) => (await one("SELECT status FROM swap_proposal WHERE swap_proposal_id = $1", [id])).status as string;
const lstatus = async (id: number) => (await one("SELECT status FROM listing WHERE listing_id = $1", [id])).status as string;

describe("proposing a direct swap", () => {
  it("records both listings, both students, the settlement and the status, and notifies the owner", async () => {
    const { alice, bob, a, b } = await pair();
    const id = await propose(alice, a, b, 50, "PROPOSER");
    const p = await one("SELECT * FROM swap_proposal WHERE swap_proposal_id = $1", [id]);
    expect(p).toMatchObject({ proposer_id: alice, receiver_id: bob, offered_listing_id: a, requested_listing_id: b, status: "PENDING", settlement_payer: "PROPOSER" });
    expect(Number(p.settlement_amount)).toBe(50);
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'SWAP_PROPOSAL'", [bob])).n).toBe(1);
    expect(await lstatus(a)).toBe("ACTIVE"); // nothing is reserved before the owner accepts
  });

  it("refuses swapping with yourself, offering a book you do not own, and the same book on both sides", async () => {
    const { alice, bob, a, b } = await pair();
    const a2 = await makeListing(alice, base.campus, null, { swap: true });
    await expect(propose(alice, a, a2)).rejects.toThrow(/yourself/);
    await expect(propose(alice, b, a)).rejects.toThrow(/yourself|own/); // B is Bob's book: the "requested" one is Alice's
    await expect(propose(alice, b, a2)).rejects.toThrow(/only offer a book that you own/);
    await expect(propose(bob, a, b)).rejects.toThrow(/only offer a book that you own/);
    await expect(propose(alice, a, a)).rejects.toThrow(/different book/);
  });

  it("refuses unavailable or not-swappable listings, auctions and bad settlements", async () => {
    const { alice, a, b } = await pair();
    const closed = await makeListing((await one("SELECT seller_id FROM listing WHERE listing_id = $1", [b])).seller_id, base.campus, null, { swap: false });
    await expect(propose(alice, a, closed)).rejects.toThrow(/not made this listing available/);
    await pool.query("UPDATE listing SET status = 'SOLD' WHERE listing_id = $1", [b]);
    await expect(propose(alice, a, b)).rejects.toThrow(/not made this listing available|no longer available/);
    const { alice: a2, a: la2, b: lb2 } = await pair();
    await pool.query("UPDATE listing SET status = 'RESERVED' WHERE listing_id = $1", [la2]);
    await expect(propose(a2, la2, lb2)).rejects.toThrow(/active fixed-price/);
    await pool.query("UPDATE listing SET status = 'ACTIVE' WHERE listing_id = $1", [la2]);
    await expect(propose(a2, la2, lb2, 10, null)).rejects.toThrow(/who pays/);
    await expect(propose(a2, la2, lb2, -5, "PROPOSER")).rejects.toThrow(/settlement/);
    await expect(propose(a2, la2, lb2, 200000, "PROPOSER")).rejects.toThrow(/settlement/);
  });

  it("a suspended student cannot propose; the same open proposal cannot be sent twice", async () => {
    const { alice, a, b } = await pair();
    await propose(alice, a, b);
    await expect(propose(alice, a, b)).rejects.toThrow(/already proposed/);
    const other = await makeListing(alice, base.campus, null, { swap: true }); // listing first: suspended students cannot create listings
    await pool.query("UPDATE student SET status = 'SUSPENDED' WHERE student_id = $1", [alice]);
    await expect(propose(alice, other, b)).rejects.toThrow(/active students/);
  });
});

describe("answering, reserving and cancelling", () => {
  it("only the receiver can accept or reject; accepting reserves BOTH listings", async () => {
    const { alice, bob, a, b } = await pair();
    const id = await propose(alice, a, b);
    await expect(respond(id, alice, "accept")).rejects.toThrow(/Only the owner/);
    await expect(respond(id, alice, "reject")).rejects.toThrow(/Only the owner/);
    const stranger = await makeStudent(base);
    await expect(respond(id, stranger, "accept")).rejects.toThrow(/not found/);
    expect(await respond(id, bob, "accept")).toBe("ACCEPTED");
    expect(await status(id)).toBe("ACCEPTED");
    expect([await lstatus(a), await lstatus(b)]).toEqual(["RESERVED", "RESERVED"]);
    await expect(respond(id, bob, "accept")).rejects.toThrow(/already accepted/);
    await expect(respond(id, bob, "reject")).rejects.toThrow(/already accepted/);
  });

  it("rejecting leaves the listings available and the proposal rejected for good", async () => {
    const { alice, bob, a, b } = await pair();
    const id = await propose(alice, a, b);
    expect(await respond(id, bob, "reject")).toBe("REJECTED");
    expect([await lstatus(a), await lstatus(b)]).toEqual(["ACTIVE", "ACTIVE"]);
    await expect(respond(id, bob, "accept")).rejects.toThrow(/already rejected/);
    await expect(respond(id, alice, "cancel")).rejects.toThrow(/already rejected/);
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND title = 'Swap rejected'", [alice])).n).toBe(1);
  });

  it("cancelling: the proposer while PENDING; either student after acceptance (listings come back); never when finished", async () => {
    const { alice, bob, a, b } = await pair();
    const id = await propose(alice, a, b);
    await expect(respond(id, bob, "cancel")).rejects.toThrow(/Only the student who proposed/);
    expect(await respond(id, alice, "cancel")).toBe("CANCELLED");
    const id2 = await propose(alice, a, b);
    await respond(id2, bob, "accept");
    expect(await respond(id2, bob, "cancel")).toBe("CANCELLED");
    expect([await lstatus(a), await lstatus(b)]).toEqual(["ACTIVE", "ACTIVE"]);
    await expect(respond(id2, alice, "cancel")).rejects.toThrow(/already cancelled/);
    // a finished swap cannot be cancelled
    const id3 = await propose(alice, a, b);
    await respond(id3, bob, "accept");
    await confirmEx(id3, alice); await confirmEx(id3, bob);
    await expect(respond(id3, alice, "cancel")).rejects.toThrow(/already completed/);
  });

  it("accepting closes other pending proposals that need one of the same books", async () => {
    const { alice, bob, a, b } = await pair();
    const carol = await makeStudent(base, "Carol");
    const c = await makeListing(carol, base.campus, await makeBook(base.course), { swap: true });
    const p1 = await propose(alice, a, b);
    const p2 = await propose(carol, c, b);          // also wants Bob's book
    const p3 = await propose(carol, c, a);          // wants Alice's book
    await respond(p1, bob, "accept");
    expect(await status(p2)).toBe("CANCELLED");
    expect(await status(p3)).toBe("CANCELLED");
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND title = 'Swap proposal closed'", [carol])).n).toBe(2);
    await expect(respond(p2, bob, "accept")).rejects.toThrow(/already cancelled/);
  });

  it("a PENDING proposal is closed when its listing is sold, removed or no longer open to swap", async () => {
    const { alice, a, b } = await pair();
    const p = await propose(alice, a, b);
    await pool.query("UPDATE listing SET open_to_swap = false WHERE listing_id = $1", [b]);
    expect(await status(p)).toBe("CANCELLED");
    await pool.query("UPDATE listing SET open_to_swap = true WHERE listing_id = $1", [b]);
    const p2 = await propose(alice, a, b);
    await pool.query("UPDATE listing SET status = 'SOLD' WHERE listing_id = $1", [a]);
    expect(await status(p2)).toBe("CANCELLED");
  });

  it("a reserved listing cannot be bought, offered on or marked as sold while the swap is accepted", async () => {
    const { alice, bob, a, b } = await pair();
    const buyer = await makeStudent(base, "Buyer");
    const id = await propose(alice, a, b);
    await respond(id, bob, "accept");
    await expect(pool.query("SELECT create_purchase($1::int, $2::int)", [b, buyer])).rejects.toThrow(/not available/);
    await expect(pool.query("INSERT INTO offer (listing_id, buyer_id, amount) VALUES ($1, $2, 10)", [b, buyer])).rejects.toThrow(/active fixed-price/);
    await expect(pool.query("SELECT mark_listing_sold($1::int, $2::int)", [b, bob])).rejects.toThrow(/Only active/);
    await expect(propose(buyer, await makeListing(buyer, base.campus, null), b)).rejects.toThrow(/no longer available/);
  });
});

describe("completing the exchange", () => {
  it("is NOT completed by accepting; it needs BOTH students to confirm, in either order", async () => {
    const { alice, bob, a, b } = await pair();
    const id = await propose(alice, a, b, 30, "RECEIVER");
    await expect(confirmEx(id, alice)).rejects.toThrow(/accepted swap/); // not accepted yet
    await respond(id, bob, "accept");
    expect(await status(id)).toBe("ACCEPTED");
    expect((await one("SELECT COUNT(*)::int AS n FROM transactions")).n).toBe(0);
    expect(await confirmEx(id, bob)).toBe("WAITING");
    expect(await status(id)).toBe("ACCEPTED");
    expect(await confirmEx(id, alice)).toBe("COMPLETED");
    expect(await status(id)).toBe("COMPLETED");
    expect([await lstatus(a), await lstatus(b)]).toEqual(["SWAPPED", "SWAPPED"]);
  });

  it("writes exactly one finished SWAP transaction, visible to both students, with the settlement amount", async () => {
    const { alice, bob, a, b } = await pair();
    const id = await propose(alice, a, b, 30, "RECEIVER");
    await respond(id, bob, "accept");
    await confirmEx(id, alice); await confirmEx(id, bob);
    const tx = (await pool.query("SELECT * FROM transactions")).rows;
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({ transaction_type: "SWAP", state: "RELEASED", buyer_id: alice, seller_id: bob, listing_id: b, swap_proposal_id: id });
    expect(Number(tx[0].amount)).toBe(30);
    for (const who of [alice, bob]) {
      expect((await pool.query("SELECT 1 FROM transactions WHERE buyer_id = $1 OR seller_id = $1", [who])).rowCount).toBe(1);
    }
  });

  it("repeating or racing confirmations cannot complete twice or create a second transaction", async () => {
    const { alice, bob, a, b } = await pair();
    const id = await propose(alice, a, b);
    await respond(id, bob, "accept");
    expect(await confirmEx(id, alice)).toBe("WAITING");
    expect(await confirmEx(id, alice)).toBe("WAITING"); // same student again: harmless
    // both confirm "at the same time" several times over fresh proposals
    const results = await Promise.allSettled([confirmEx(id, alice), confirmEx(id, bob), confirmEx(id, bob), confirmEx(id, alice)]);
    expect(results.filter((r) => r.status === "fulfilled" && r.value === "COMPLETED")).toHaveLength(1);
    expect((await one("SELECT COUNT(*)::int AS n FROM transactions")).n).toBe(1);
    await expect(confirmEx(id, alice)).rejects.toThrow(/completed/);
    expect((await one("SELECT COUNT(*)::int AS n FROM transactions")).n).toBe(1);
    const rep = await one("SELECT completed_transactions, completed_swaps FROM v_student_ratings WHERE student_id = $1", [alice]);
    expect(rep).toMatchObject({ completed_transactions: 1, completed_swaps: 1 });
  });

  it("strangers cannot confirm; a second transaction for the same proposal is blocked by the database", async () => {
    const { alice, bob, a, b } = await pair();
    const stranger = await makeStudent(base);
    const id = await propose(alice, a, b);
    await respond(id, bob, "accept");
    await expect(confirmEx(id, stranger)).rejects.toThrow(/not found/);
    await confirmEx(id, alice); await confirmEx(id, bob);
    await expect(pool.query(
      "INSERT INTO transactions (listing_id, buyer_id, seller_id, amount, transaction_type, swap_proposal_id, state) VALUES ($1, $2, $3, 0, 'SWAP', $4, 'RELEASED')",
      [b, alice, bob, id])).rejects.toMatchObject({ code: "23505" });
  });

  it("both students can rate a finished swap once each, and nobody else can", async () => {
    const { alice, bob, a, b } = await pair();
    const stranger = await makeStudent(base);
    const id = await propose(alice, a, b);
    await respond(id, bob, "accept");
    const tx = async () => (await one("SELECT transaction_id FROM transactions")).transaction_id as number;
    await confirmEx(id, alice);
    expect((await pool.query("SELECT 1 FROM transactions")).rowCount).toBe(0); // nothing to rate before completion
    await confirmEx(id, bob);
    const t = await tx();
    const rate = (rater: number, ratee: number, score: number) => pool.query("INSERT INTO rating (transaction_id, rater_id, ratee_id, score) VALUES ($1, $2, $3, $4)", [t, rater, ratee, score]);
    await rate(alice, bob, 5);
    await rate(bob, alice, 4);
    await expect(rate(alice, bob, 3)).rejects.toMatchObject({ code: "23505" });
    await expect(rate(stranger, bob, 5)).rejects.toMatchObject({ code: "23514" });
    await expect(rate(alice, alice, 5)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("what the page offers (lib/swaps.ts)", () => {
  const base2 = { proposer_id: 1, receiver_id: 2, proposer_confirmed_at: null, receiver_confirmed_at: null };
  it("shows only the buttons that make sense", () => {
    expect(swapActionsFor({ ...base2, status: "PENDING" }, 2)).toEqual(["accept", "reject"]);
    expect(swapActionsFor({ ...base2, status: "PENDING" }, 1)).toEqual(["cancel"]);
    expect(swapActionsFor({ ...base2, status: "PENDING" }, 3)).toEqual([]);
    expect(swapActionsFor({ ...base2, status: "ACCEPTED" }, 1)).toEqual(["confirm", "cancel"]);
    expect(swapActionsFor({ ...base2, status: "ACCEPTED", proposer_confirmed_at: "x" }, 1)).toEqual(["cancel"]);
    for (const s of ["COMPLETED", "REJECTED", "CANCELLED"]) expect(swapActionsFor({ ...base2, status: s }, 1)).toEqual([]);
  });
});
