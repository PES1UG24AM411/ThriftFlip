// Price alerts with similar titles (db/migrations/021_price_alert_book_match_percent.sql): the same book written differently by
// different students is found, the notification says how sure the match is, and the alerted student can message the seller.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { makeBook, makeListing, makeStudent, one, pool, resetData, setupCampus } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const OFFICIAL = { title: "Computer Networking: A Top-Down Approach", author: "James Kurose, Keith Ross" };
const pct = async (a: number, b: number) => (await one("SELECT book_match_percent($1::int, $2::int) AS p", [a, b])).p as number;
const mkAlert = (student: number, book: number, max: number, minCondition: string | null = null) =>
  one("SELECT create_price_alert($1::int, $2::int, $3::numeric, $4::text) AS id", [student, book, max, minCondition]);
const alertsFor = async (student: number) =>
  (await pool.query("SELECT * FROM notification WHERE student_id = $1 AND type = 'PRICE_ALERT' ORDER BY notification_id", [student])).rows;
const setPrice = (listing: number, price: number) => pool.query("UPDATE listing SET price = $2 WHERE listing_id = $1", [listing, price]);

describe("book match percentage", () => {
  it("is 100 for the same catalogue row", async () => {
    const a = await makeBook(base.course, OFFICIAL);
    expect(await pct(a, a)).toBe(100);
  });

  it("is 100 when only capital letters and punctuation differ", async () => {
    const a = await makeBook(base.course, OFFICIAL);
    const b = await makeBook(base.course, { title: "computer networking - a top down approach!", author: "Kurose" });
    expect(await pct(a, b)).toBe(100);
  });

  it("is high but below 100 for the same book named differently, and shows in the 70s-90s", async () => {
    const a = await makeBook(base.course, OFFICIAL);
    const variant = await makeBook(base.course, { title: "Computer Networks: Top Down Approach", author: "Kurose" });
    const shorter = await makeBook(base.course, { title: "Computer Networking", author: "James Kurose, Keith Ross" });
    for (const b of [variant, shorter]) {
      const p = await pct(a, b);
      expect(p).toBeGreaterThanOrEqual(70);
      expect(p).toBeLessThan(100);
    }
  });

  it("is symmetrical enough to use in both directions", async () => {
    const a = await makeBook(base.course, OFFICIAL);
    const b = await makeBook(base.course, { title: "Computer Networks: Top Down Approach", author: "Kurose" });
    expect(Math.abs((await pct(a, b)) - (await pct(b, a)))).toBeLessThan(2);
  });

  it("another edition (both given) is another book; an unspecified edition still matches, a little lower", async () => {
    const a = await makeBook(base.course, { ...OFFICIAL, edition: 7 });
    const same = await makeBook(base.course, { title: "Computer Networks Top Down Approach", author: "Kurose", edition: 7 });
    const other = await makeBook(base.course, { title: "Computer Networks Top Down Approach", author: "Kurose", edition: 8 });
    const unspecified = await makeBook(base.course, { title: "Computer Networks Top Down Approach", author: "Kurose", edition: 1 });
    expect(await pct(a, other)).toBeLessThan(70);
    expect(await pct(a, unspecified)).toBeGreaterThanOrEqual(70);
    expect(await pct(a, unspecified)).toBeLessThan(await pct(a, same));
  });

  it("different books stay below the alert limit, even when words and authors overlap", async () => {
    const db = await makeBook(base.course, { title: "Database System Concepts", author: "Abraham Silberschatz" });
    const os = await makeBook(base.course, { title: "Operating System Concepts", author: "Abraham Silberschatz" });
    const graphics = await makeBook(base.course, { title: "Computer Graphics", author: "Donald Hearn" });
    const official = await makeBook(base.course, OFFICIAL);
    expect(await pct(db, os)).toBeLessThan(70);
    expect(await pct(official, graphics)).toBeLessThan(70);
  });

  it("the same title by clearly different authors is not a match", async () => {
    const a = await makeBook(base.course, { title: "Database Systems", author: "Ramez Elmasri" });
    const b = await makeBook(base.course, { title: "Database Systems", author: "Raghu Ramakrishnan" });
    expect(await pct(a, b)).toBeLessThan(70);
  });

  it("is 0 for a missing book", async () => {
    const a = await makeBook(base.course, OFFICIAL);
    expect(await pct(a, 999999)).toBe(0);
  });
});

describe("price alert for a book written differently (Rs 499 against a Rs 500 alert)", () => {
  async function scene() {
    const shweta = await makeStudent(base, "Shweta");
    const tasya = await makeStudent(base, "Tasya");
    const official = await makeBook(base.course, OFFICIAL);
    const variant = await makeBook(base.course, { title: "Computer Networks: Top Down Approach", author: "Kurose" });
    return { shweta, tasya, official, variant };
  }

  it("notifies with the percentage, the alert's book and the seller, for a similar title at Rs 499", async () => {
    const { shweta, tasya, official, variant } = await scene();
    await mkAlert(shweta, official, 500);
    const listing = await makeListing(tasya, base.campus, variant, { title: "Computer Networks: Top Down Approach", price: 499 });
    const n = await alertsFor(shweta);
    expect(n).toHaveLength(1);
    expect(n[0].related_listing_id).toBe(listing);
    expect(n[0].title).toMatch(/^Price alert · \d+% match$/);
    expect(n[0].body).toMatch(/\d+% match with your alert for "Computer Networking: A Top-Down Approach"/);
    expect(n[0].body).toContain("499");
    expect(n[0].body).toContain("Tasya");
    const stored = (await one("SELECT match_percent FROM price_alert_notice WHERE student_id = $1 AND listing_id = $2", [shweta, listing])).match_percent as number;
    expect(stored).toBeGreaterThanOrEqual(70);
    expect(stored).toBeLessThan(100);
    expect(n[0].title).toContain(`${stored}%`);
  });

  it("an exact match says so and has no percentage in the title", async () => {
    const { shweta, tasya, official } = await scene();
    await mkAlert(shweta, official, 500);
    await makeListing(tasya, base.campus, official, { price: 499 });
    const n = await alertsFor(shweta);
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe("Price alert");
    expect(n[0].body).toContain("Exact match");
  });

  it("does not notify for a price above the limit, a different book, or the owner's own listing", async () => {
    const { shweta, tasya, official, variant } = await scene();
    const other = await makeBook(base.course, { title: "Database System Concepts", author: "Abraham Silberschatz" });
    await mkAlert(shweta, official, 500);
    await makeListing(tasya, base.campus, variant, { price: 520 }); // too expensive
    await makeListing(tasya, base.campus, other, { price: 100 }); // different book
    await makeListing(shweta, base.campus, variant, { price: 450 }); // her own listing
    expect(await alertsFor(shweta)).toHaveLength(0);
  });

  it("an alert created AFTER the similar listing exists is announced at once", async () => {
    const { shweta, tasya, official, variant } = await scene();
    await makeListing(tasya, base.campus, variant, { price: 499 });
    await mkAlert(shweta, official, 500);
    expect(await alertsFor(shweta)).toHaveLength(1);
  });

  it("a price reduction below the limit notifies; the same price again, and an unrelated edit, do not", async () => {
    const { shweta, tasya, official, variant } = await scene();
    await mkAlert(shweta, official, 500);
    const listing = await makeListing(tasya, base.campus, variant, { price: 600 });
    expect(await alertsFor(shweta)).toHaveLength(0);
    await setPrice(listing, 499);
    expect(await alertsFor(shweta)).toHaveLength(1);
    await pool.query("UPDATE listing SET description = 'edited' WHERE listing_id = $1", [listing]);
    await setPrice(listing, 499);
    expect(await alertsFor(shweta)).toHaveLength(1); // no duplicate for the same listing and price
    await setPrice(listing, 480);
    expect(await alertsFor(shweta)).toHaveLength(2); // a new, lower price is a new qualifying event
  });

  it("a student with two alerts for the same book gets ONE notification, with the best match", async () => {
    const { shweta, tasya, official, variant } = await scene();
    await mkAlert(shweta, variant, 500); // 100% for this listing's own book
    await mkAlert(shweta, official, 500); // a lower match
    await makeListing(tasya, base.campus, variant, { price: 499 });
    const n = await alertsFor(shweta);
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe("Price alert");
    expect(n[0].body).toContain("Exact match");
  });

  it("several students with alerts are each notified once, and only the eligible ones", async () => {
    const { shweta, tasya, official, variant } = await scene();
    const [a, b, c] = [await makeStudent(base, "A"), await makeStudent(base, "B"), await makeStudent(base, "C")];
    await mkAlert(shweta, official, 500);
    await mkAlert(a, variant, 499); // exactly at the limit
    await mkAlert(b, official, 450); // limit too low
    await mkAlert(c, official, 500, "LIKE_NEW"); // wants a better condition than GOOD
    await makeListing(tasya, base.campus, variant, { price: 499, cond: "GOOD" });
    expect(await alertsFor(shweta)).toHaveLength(1);
    expect(await alertsFor(a)).toHaveLength(1);
    expect(await alertsFor(b)).toHaveLength(0);
    expect(await alertsFor(c)).toHaveLength(0);
  });

  it("the alerted student can message the seller of the listing in the notification (one chat, however often they click)", async () => {
    const { shweta, tasya, official, variant } = await scene();
    await mkAlert(shweta, official, 500);
    const listing = await makeListing(tasya, base.campus, variant, { price: 499 });
    const n = (await alertsFor(shweta))[0];
    expect(n.related_listing_id).toBe(listing);
    // what POST /api/conversations does for { listingId }
    const open = async () => (await one(
      `INSERT INTO conversation (listing_id, buyer_id, seller_id)
       SELECT l.listing_id, $2, l.seller_id FROM listing l WHERE l.listing_id = $1
       ON CONFLICT (listing_id, buyer_id) DO UPDATE SET listing_id = EXCLUDED.listing_id RETURNING conversation_id, seller_id`,
      [n.related_listing_id, shweta])) as { conversation_id: number; seller_id: number };
    const first = await open();
    expect(first.seller_id).toBe(tasya);
    expect((await open()).conversation_id).toBe(first.conversation_id);
  });
});
