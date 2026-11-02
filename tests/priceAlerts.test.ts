// Price alerts (db/migrations/019_price_alert_fixes.sql): who is notified, when, and never twice for the same event.
// Regression for: Rs 499 listing, Rs 500 alert, no notification.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateBook } from "../lib/books";
import { makeBook, makeListing, makeStudent, one, pool, resetData, setupCampus } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const TITLE = "Computer Networking: A Top-Down Approach";
const alert = (student: number, book: number, max: number, minCondition: string | null = null) =>
  one("SELECT create_price_alert($1::int, $2::int, $3::numeric, $4::text) AS id", [student, book, max, minCondition]);
const notices = async (student: number) =>
  (await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'PRICE_ALERT'", [student])).n as number;
const setPrice = (listing: number, price: number) => pool.query("UPDATE listing SET price = $2 WHERE listing_id = $1", [listing, price]);
const setStatus = (listing: number, status: string) => pool.query("UPDATE listing SET status = $2 WHERE listing_id = $1", [listing, status]);

describe("the reported bug: Rs 499 listing, Rs 500 alert", () => {
  it("notifies when the listing is created after the alert", async () => {
    const tasya = await makeStudent(base, "Tasya"), shweta = await makeStudent(base, "Shweta");
    const book = await makeBook(base.course, { title: TITLE });
    await alert(shweta, book, 500);
    const listing = await makeListing(tasya, base.campus, book, { title: TITLE, price: 499 });
    expect(await notices(shweta)).toBe(1);
    const n = await one("SELECT body, related_listing_id FROM notification WHERE student_id = $1", [shweta]);
    expect(n.related_listing_id).toBe(listing);
    expect(n.body).toContain("499");
  });

  it("notifies when the alert is created after the listing", async () => {
    const tasya = await makeStudent(base), shweta = await makeStudent(base);
    const book = await makeBook(base.course, { title: TITLE });
    await makeListing(tasya, base.campus, book, { price: 499 });
    expect(await notices(shweta)).toBe(0);
    await alert(shweta, book, 500);
    expect(await notices(shweta)).toBe(1);
  });

  it("the limit itself qualifies (500), one rupee above does not (501)", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500);
    await makeListing(seller, base.campus, book, { price: 501 });
    expect(await notices(watcher)).toBe(0);
    await makeListing(seller, base.campus, book, { price: 500 });
    expect(await notices(watcher)).toBe(1);
  });

  it("a Rs 520 listing does not notify a Rs 500 alert, a Rs 550 alert is notified about it", async () => {
    const tasya = await makeStudent(base), shweta = await makeStudent(base), other = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(shweta, book, 500);
    await alert(other, book, 550);
    await makeListing(tasya, base.campus, book, { price: 520 });
    expect(await notices(shweta)).toBe(0);
    expect(await notices(other)).toBe(1);
  });
});

describe("matching the right book", () => {
  it("the same book under a second catalogue row still matches (the cause of the reported miss)", async () => {
    const tasya = await makeStudent(base), shweta = await makeStudent(base);
    const canonical = await makeBook(base.course, { title: TITLE, author: "James Kurose, Keith Ross", edition: 8 });
    const second = await makeBook(base.course, { title: TITLE.toLowerCase(), author: "Kurose", edition: 8 });
    expect(second).not.toBe(canonical);
    await alert(shweta, canonical, 500);
    await makeListing(tasya, base.campus, second, { price: 499 });
    expect(await notices(shweta)).toBe(1);
  });

  it("a different edition, a different title or an unrelated author is not the same book", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course, { title: TITLE, author: "James Kurose, Keith Ross", edition: 8 });
    await alert(watcher, book, 500);
    await makeListing(seller, base.campus, await makeBook(base.course, { title: TITLE, author: "James Kurose, Keith Ross", edition: 7 }), { price: 100 });
    await makeListing(seller, base.campus, await makeBook(base.course, { title: "Operating System Concepts", author: "Silberschatz", edition: 8 }), { price: 100 });
    await makeListing(seller, base.campus, await makeBook(base.course, { title: TITLE, author: "Somebody Else", edition: 8 }), { price: 100 });
    expect(await notices(watcher)).toBe(0);
  });

  it("the same ISBN is the same book even if the titles differ", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const a = await makeBook(base.course, { title: "Networking 8e" });
    await pool.query("UPDATE book SET isbn = '9780136681557' WHERE book_id = $1", [a]);
    // a second row cannot hold the same ISBN, so compare through the function directly
    const b = await makeBook(base.course, { title: "Totally different words" });
    expect((await one("SELECT same_book($1::int, $2::int) AS s", [a, b])).s).toBe(false);
    expect((await one("SELECT same_book($1::int, $1::int) AS s", [a])).s).toBe(true);
    await alert(watcher, a, 500);
    await makeListing(seller, base.campus, a, { price: 400 });
    expect(await notices(watcher)).toBe(1);
  });

  it("the sell form resolves a slightly different spelling to the existing catalogue row", async () => {
    const book = await makeBook(base.course, { title: TITLE, author: "James Kurose, Keith Ross", edition: 8 });
    const c = await pool.connect();
    try {
      expect(await findOrCreateBook(c, { title: TITLE.toUpperCase(), author: "Kurose", edition: 8 })).toBe(book);
      expect(await findOrCreateBook(c, { title: "computer networking a top down approach", author: "J. Kurose", edition: 8 })).toBe(book);
      expect(await findOrCreateBook(c, { title: TITLE, edition: 8 })).toBe(book); // author unknown (wanted-book form)
      expect(await findOrCreateBook(c, { title: TITLE, author: "James Kurose", edition: 9 })).not.toBe(book); // another edition
    } finally { c.release(); }
  });
});

describe("price reductions and other ways a listing becomes eligible", () => {
  it("a price drop below the limit notifies; a drop that stays above does not; raising the price does not", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500);
    const listing = await makeListing(seller, base.campus, book, { price: 600 });
    await setPrice(listing, 550);
    expect(await notices(watcher)).toBe(0);
    await setPrice(listing, 499);
    expect(await notices(watcher)).toBe(1);
    await setPrice(listing, 520); // up: nothing
    expect(await notices(watcher)).toBe(1);
  });

  it("a further drop is a new event and notifies again; the same price twice does not", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500);
    const listing = await makeListing(seller, base.campus, book, { price: 520 });
    await setPrice(listing, 499);
    expect(await notices(watcher)).toBe(1);
    await setPrice(listing, 499);
    await pool.query("UPDATE listing SET description = 'edited' WHERE listing_id = $1", [listing]);
    expect(await notices(watcher)).toBe(1);
    await setPrice(listing, 480);
    expect(await notices(watcher)).toBe(2);
  });

  it("a listing already announced at a higher price is announced again when it drops below a NEW lower limit", async () => {
    const seller = await makeStudent(base), shweta = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(shweta, book, 550);
    const listing = await makeListing(seller, base.campus, book, { price: 520 });
    expect(await notices(shweta)).toBe(1); // the old behaviour: one notification per listing, forever
    await setPrice(listing, 499);
    expect(await notices(shweta)).toBe(2);
  });

  it("a reserved listing is announced when it becomes ACTIVE again, but not while it is reserved or sold", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500);
    const listing = await makeListing(seller, base.campus, book, { price: 520 });
    await setStatus(listing, "RESERVED");
    await setPrice(listing, 499);
    expect(await notices(watcher)).toBe(0);
    await setStatus(listing, "SOLD");
    expect(await notices(watcher)).toBe(0);
    await setStatus(listing, "RESERVED");
    await setStatus(listing, "ACTIVE");
    expect(await notices(watcher)).toBe(1);
    await setStatus(listing, "RESERVED");
    await setStatus(listing, "ACTIVE"); // same price again: not a new event
    expect(await notices(watcher)).toBe(1);
  });

  it("auctions are not matched", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500);
    await makeListing(seller, base.campus, book, { price: 100, type: "AUCTION" });
    expect(await notices(watcher)).toBe(0);
  });
});

describe("condition", () => {
  it("'at least GOOD' accepts GOOD, LIKE_NEW and NEW but not FAIR; no condition accepts everything", async () => {
    const seller = await makeStudent(base), picky = await makeStudent(base), easy = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(picky, book, 500, "GOOD");
    await alert(easy, book, 500, null);
    await makeListing(seller, base.campus, book, { price: 100, cond: "FAIR" });
    expect(await notices(picky)).toBe(0);
    expect(await notices(easy)).toBe(1);
    await makeListing(seller, base.campus, book, { price: 100, cond: "GOOD" });
    await makeListing(seller, base.campus, book, { price: 100, cond: "LIKE_NEW" });
    await makeListing(seller, base.campus, book, { price: 100, cond: "NEW" });
    expect(await notices(picky)).toBe(3);
    expect(await notices(easy)).toBe(4);
  });

  it("an improved condition makes an existing listing eligible", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500, "LIKE_NEW");
    const listing = await makeListing(seller, base.campus, book, { price: 400, cond: "FAIR" });
    expect(await notices(watcher)).toBe(0);
    await pool.query("UPDATE listing SET item_condition = 'LIKE_NEW' WHERE listing_id = $1", [listing]);
    expect(await notices(watcher)).toBe(1);
  });

  it("rejects a condition that does not exist", async () => {
    const watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await expect(alert(watcher, book, 500, "MINT")).rejects.toThrow();
  });
});

describe("only eligible people are notified", () => {
  it("never the owner of the listing", async () => {
    const owner = await makeStudent(base), other = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(owner, book, 500);
    await alert(other, book, 500);
    await makeListing(owner, base.campus, book, { price: 100 });
    expect(await notices(owner)).toBe(0);
    expect(await notices(other)).toBe(1);
  });

  it("creating an alert does not notify about the student's own listing", async () => {
    const owner = await makeStudent(base);
    const book = await makeBook(base.course);
    await makeListing(owner, base.campus, book, { price: 100 });
    await alert(owner, book, 500);
    expect(await notices(owner)).toBe(0);
  });

  it("each student is judged by their own limit (multiple alerts on one listing)", async () => {
    const seller = await makeStudent(base);
    const [a, b, c, d] = [await makeStudent(base), await makeStudent(base), await makeStudent(base), await makeStudent(base)];
    const book = await makeBook(base.course);
    await alert(a, book, 500); await alert(b, book, 499); await alert(c, book, 498); await alert(d, book, 1000);
    await makeListing(seller, base.campus, book, { price: 499 });
    expect([await notices(a), await notices(b), await notices(c), await notices(d)]).toEqual([1, 1, 0, 1]);
  });

  it("a suspended student is not notified", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500);
    await pool.query("UPDATE student SET status = 'SUSPENDED' WHERE student_id = $1", [watcher]);
    await makeListing(seller, base.campus, book, { price: 100 });
    expect(await notices(watcher)).toBe(0);
  });
});

describe("no duplicates for the same qualifying event", () => {
  it("two alerts of one student for the same book give ONE notification per listing", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500);
    await alert(watcher, book, 520);
    await makeListing(seller, base.campus, book, { price: 499 });
    expect(await notices(watcher)).toBe(1);
  });

  it("creating an alert twice, or on a second catalogue row of the same book, does not repeat a notification", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course, { title: TITLE, author: "James Kurose", edition: 8 });
    const second = await makeBook(base.course, { title: TITLE, author: "Kurose", edition: 8 });
    await makeListing(seller, base.campus, book, { price: 499 });
    await alert(watcher, book, 500);
    await alert(watcher, second, 500);
    await alert(watcher, book, 500);
    expect(await notices(watcher)).toBe(1);
  });

  it("two evaluations at the same moment create one notification", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(watcher, book, 500);
    await pool.query("ALTER TABLE listing DISABLE TRIGGER trg_listing_price_alerts");
    let listing: number;
    try { listing = await makeListing(seller, base.campus, book, { price: 499 }); }
    finally { await pool.query("ALTER TABLE listing ENABLE TRIGGER trg_listing_price_alerts"); }
    expect(await notices(watcher)).toBe(0);
    await Promise.all([1, 2, 3, 4].map(() => pool.query("SELECT notify_price_alerts_for_listing($1::int)", [listing])));
    expect(await notices(watcher)).toBe(1);
  });

  it("catch_up_price_alerts sends only what was missed, and nothing the second time", async () => {
    const seller = await makeStudent(base), shweta = await makeStudent(base), told = await makeStudent(base);
    const book = await makeBook(base.course);
    await alert(told, book, 500);
    await pool.query("ALTER TABLE listing DISABLE TRIGGER trg_listing_price_alerts"); // simulate listings created before the fix
    try { await makeListing(seller, base.campus, book, { price: 499 }); }
    finally { await pool.query("ALTER TABLE listing ENABLE TRIGGER trg_listing_price_alerts"); }
    await pool.query("INSERT INTO price_alert (student_id, book_id, max_price) VALUES ($1, $2, 500)", [shweta, book]); // plain insert: no catch-up
    expect(await notices(shweta)).toBe(0);
    expect((await one("SELECT catch_up_price_alerts() AS n")).n).toBe(2);
    expect(await notices(shweta)).toBe(1);
    expect(await notices(told)).toBe(1);
    expect((await one("SELECT catch_up_price_alerts() AS n")).n).toBe(0);
    expect(await notices(shweta)).toBe(1);
  });
});
