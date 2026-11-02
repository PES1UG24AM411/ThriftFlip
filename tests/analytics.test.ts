import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, completeSale, one } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const fair = async (bookId: number, cond: string) =>
  (await pool.query("SELECT * FROM calculate_fair_price($1::int, $2::text)", [bookId, cond])).rows[0];

describe("fair price (30% title, 25% edition, 25% condition, 20% course)", () => {
  it("returns NULL when there is no sales history", async () => {
    const book = await makeBook(base.course);
    const r = await fair(book, "GOOD");
    expect(r.estimated_price).toBeNull();
    expect(r.sample_size).toBe(0);
  });

  it("applies the weights to real sales and reports min/avg/max", async () => {
    const seller = await makeStudent(base), buyer = await makeStudent(base);
    const book = await makeBook(base.course, { title: "ML", author: "Bishop", subject: "ML" });
    await completeSale(await makeListing(seller, base.campus, book, { price: 100, cond: "GOOD" }), buyer);
    await completeSale(await makeListing(seller, base.campus, book, { price: 200, cond: "FAIR" }), buyer);
    const r = await fair(book, "GOOD");
    // title avg 150, edition avg 150, condition(GOOD, same subject) avg 100, course avg 150
    // 0.30*150 + 0.25*150 + 0.25*100 + 0.20*150 = 137.50
    expect(Number(r.estimated_price)).toBe(137.5);
    expect([Number(r.historical_min), Number(r.historical_avg), Number(r.historical_max), r.sample_size]).toEqual([100, 150, 200, 2]);
  });

  it("re-scales the weights when a component has no data", async () => {
    const seller = await makeStudent(base), buyer = await makeStudent(base);
    const book = await makeBook(null, { title: "NoCourse", author: "A", subject: "S" }); // no course: course component missing
    await completeSale(await makeListing(seller, base.campus, book, { price: 100, cond: "GOOD" }), buyer);
    const r = await fair(book, "FAIR"); // no FAIR sale: condition component missing
    expect(Number(r.estimated_price)).toBe(100); // only title (0.30) and edition (0.25) remain, both 100
  });

  it("ignores swaps and unfinished sales", async () => {
    const seller = await makeStudent(base), buyer = await makeStudent(base);
    const book = await makeBook(base.course);
    await completeSale(await makeListing(seller, base.campus, book, { price: 500 }), buyer, "PAYMENT_HELD");
    expect((await fair(book, "GOOD")).estimated_price).toBeNull();
  });
});

describe("demand analytics", () => {
  it("classifies HIGH / MEDIUM / LOW from wishlists, searches, bids, swaps and supply", async () => {
    const seller = await makeStudent(base);
    const fans = [await makeStudent(base), await makeStudent(base)];
    const hot = await makeBook(base.course, { title: "Hot" });
    const warm = await makeBook(base.course, { title: "Warm" });
    const cold = await makeBook(base.course, { title: "Cold" });
    const lHot = await makeListing(seller, base.campus, hot);
    const lWarm = await makeListing(seller, base.campus, warm);
    await makeListing(seller, base.campus, cold);
    for (const f of fans) await pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2)", [f, lHot]); // 2 x 2 = 4
    await pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2)", [fans[0], lWarm]); // 2
    for (let i = 0; i < 3; i++) await pool.query("INSERT INTO search_activity (student_id, query_text, book_id) VALUES ($1, 'x', $2)", [fans[0], hot]); // +3
    const rows = (await pool.query("SELECT title, demand_score, demand_level FROM v_book_demand")).rows;
    const by = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect(by.Hot).toMatchObject({ demand_score: 7, demand_level: "HIGH" });   // 7 / 1 listing >= 6
    expect(by.Warm).toMatchObject({ demand_score: 2, demand_level: "MEDIUM" }); // 2 / 1 >= 2
    expect(by.Cold).toMatchObject({ demand_score: 0, demand_level: "LOW" });
  });

  it("more supply lowers demand; old searches do not count; course demand sums its books", async () => {
    const seller = await makeStudent(base), fan = await makeStudent(base);
    const book = await makeBook(base.course, { title: "Popular" });
    const l = await makeListing(seller, base.campus, book);
    await pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2)", [fan, l]);
    await pool.query("INSERT INTO search_activity (student_id, query_text, book_id, searched_at) VALUES ($1, 'old', $2, now() - INTERVAL '60 days')", [fan, book]);
    expect((await one("SELECT demand_score FROM v_book_demand WHERE book_id = $1", [book])).demand_score).toBe(2);
    for (let i = 0; i < 3; i++) await makeListing(seller, base.campus, book); // supply 4 -> ratio 0.5
    expect((await one("SELECT demand_level FROM v_book_demand WHERE book_id = $1", [book])).demand_level).toBe("LOW");
    const course = await one("SELECT demand_score, books_count FROM v_course_demand WHERE course_id = $1", [base.course]);
    expect(course.demand_score).toBe(2);
    expect(course.books_count).toBe(1);
  });
});

describe("full-text search (tsvector + GIN)", () => {
  it("finds listings by title, author, subject and course, ranked by relevance", async () => {
    const seller = await makeStudent(base);
    const ml = await makeBook(base.course, { title: "Pattern Recognition", author: "Bishop", subject: "Machine Learning" });
    const db = await makeBook(base.course2, { title: "Database Systems", author: "Silberschatz", subject: "Databases" });
    const l1 = await makeListing(seller, base.campus, ml, { title: "Pattern Recognition and Machine Learning", description: "clean copy" });
    const l2 = await makeListing(seller, base.campus, db, { title: "Database System Concepts", description: "mentions machine learning once" });
    const search = async (q: string) =>
      (await pool.query(
        `SELECT l.listing_id FROM listing l WHERE l.search_vector @@ websearch_to_tsquery('english', $1)
         ORDER BY ts_rank(l.search_vector, websearch_to_tsquery('english', $1)) DESC`, [q])).rows.map((r) => r.listing_id);
    expect(await search("machine learning")).toEqual([l1, l2]); // title/subject weight beats description
    expect(await search("Bishop")).toEqual([l1]);               // author
    expect(await search("databases")).toEqual([l2]);            // subject
    expect(await search("Databases CS200")).toEqual([l2]);      // course code
    expect(await search("quantum")).toEqual([]);
  });

  it("keeps the search vector up to date when a listing is edited, and a GIN index exists", async () => {
    const seller = await makeStudent(base);
    const l = await makeListing(seller, base.campus, null, { title: "Old title" });
    await pool.query("UPDATE listing SET title = 'Thermodynamics notes' WHERE listing_id = $1", [l]);
    const hit = await pool.query("SELECT 1 FROM listing WHERE search_vector @@ websearch_to_tsquery('english', 'thermodynamics') AND listing_id = $1", [l]);
    expect(hit.rowCount).toBe(1);
    const idx = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_listing_search_vector'");
    expect(idx.rows[0].indexdef).toMatch(/USING gin/i);
  });
});

describe("price alerts and moderation", () => {
  it("a new listing at or below the alert price notifies the student (trigger)", async () => {
    const seller = await makeStudent(base), watcher = await makeStudent(base);
    const book = await makeBook(base.course);
    await pool.query("INSERT INTO price_alert (student_id, book_id, max_price) VALUES ($1, $2, 300)", [watcher, book]);
    await makeListing(seller, base.campus, book, { price: 450 });
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1", [watcher])).n).toBe(0);
    await makeListing(seller, base.campus, book, { price: 280 });
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'PRICE_ALERT'", [watcher])).n).toBe(1);
    expect((await one("SELECT is_active FROM price_alert WHERE student_id = $1", [watcher])).is_active).toBe(false);
  });

  it("report workflow: nothing happens until an admin decides, and every step has a reason", async () => {
    const admin = (await one("INSERT INTO admin (name, email, password_hash) VALUES ('A', 'a@t.local', $1) RETURNING admin_id", ["h".repeat(60)])).admin_id;
    const reporter = await makeStudent(base), bad = await makeStudent(base);
    const listing = await makeListing(bad, base.campus, null);
    const report = async (reason = "SCAM") =>
      (await one("INSERT INTO report (reporter_id, reported_listing_id, reason) VALUES ($1, $2, $3) RETURNING report_id", [reporter, listing, reason])).report_id;
    const status = (id: number, s: string, why = "Checked it") => pool.query("SELECT admin_set_report_status($1::int, $2::int, $3::text, $4::text)", [admin, id, s, why]);
    const act = (action: string, why: string, o: { student?: number; listing?: number; report?: number }) =>
      pool.query("SELECT admin_take_action($1::int, $2::text, $3::text, $4::int, $5::int, NULL, $6::int)", [admin, action, why, o.student ?? null, o.listing ?? null, o.report ?? null]);

    const r1 = await report();
    expect((await one("SELECT status FROM report WHERE report_id = $1", [r1])).status).toBe("PENDING");
    // a report alone never punishes anybody
    expect((await one("SELECT warning_count, status FROM student WHERE student_id = $1", [bad]))).toMatchObject({ warning_count: 0, status: "ACTIVE" });
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("ACTIVE");
    // the order is enforced and a reason is required
    await expect(status(r1, "RESOLVED")).rejects.toThrow(/Start the review/);
    await expect(act("WARN_USER", "Not yet", { student: bad, report: r1 })).rejects.toThrow(/Start the review/);
    await expect(status(r1, "UNDER_REVIEW", "")).rejects.toThrow(/reason/);
    await status(r1, "UNDER_REVIEW");

    await act("WARN_USER", "Misleading description", { student: bad, report: r1 });
    expect((await one("SELECT warning_count FROM student WHERE student_id = $1", [bad])).warning_count).toBe(1);
    await act("REMOVE_LISTING", "Fake listing", { listing, report: r1 });
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("REMOVED");
    await status(r1, "RESOLVED", "Warned and removed");
    await expect(status(r1, "DISMISSED")).rejects.toThrow(/review/);
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'REPORT_UPDATE'", [reporter])).n).toBeGreaterThan(0);
    // the student was told, can reply, and the actions are on record
    expect((await one("SELECT COUNT(*)::int AS n FROM admin_message WHERE student_id = $1 AND sender_type = 'ADMIN'", [bad])).n).toBe(2);
    expect((await one("SELECT COUNT(*)::int AS n FROM admin_action WHERE report_id = $1", [r1])).n).toBe(4);

    // dismissed reports change nothing
    const r2 = await report("SPAM");
    await status(r2, "UNDER_REVIEW");
    await status(r2, "DISMISSED", "Unfounded");
    expect((await one("SELECT status FROM student WHERE student_id = $1", [bad])).status).toBe("ACTIVE");

    // suspension removes active listings; the account cannot list until reactivated
    const second = await makeListing(bad, base.campus, null);
    await act("SUSPEND_USER", "Repeated scams", { student: bad });
    expect((await one("SELECT status FROM student WHERE student_id = $1", [bad])).status).toBe("SUSPENDED");
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [second])).status).toBe("REMOVED");
    await expect(makeListing(bad, base.campus, null)).rejects.toThrow(/Suspended/);
    await act("REACTIVATE_USER", "Appeal accepted", { student: bad });
    expect((await one("SELECT status FROM student WHERE student_id = $1", [bad])).status).toBe("ACTIVE");
  });

  it("admin messages: the student is notified", async () => {
    const admin = (await one("INSERT INTO admin (name, email, password_hash) VALUES ('A', 'a@t.local', $1) RETURNING admin_id", ["h".repeat(60)])).admin_id;
    const s = await makeStudent(base);
    await pool.query("SELECT admin_send_message($1::int, $2::int, 'Please add the edition to your listing', 'CLARIFICATION')", [admin, s]);
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'ADMIN_MESSAGE'", [s])).n).toBe(1);
  });
});
