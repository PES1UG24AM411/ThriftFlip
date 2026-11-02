import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, one, completeSale } from "./helpers";

let base: Awaited<ReturnType<typeof setupCampus>>;
let me: number, seller: number;
beforeEach(async () => { await resetData(); base = await setupCampus(); me = await makeStudent(base, "Me", 5); seller = await makeStudent(base, "Seller"); });
afterAll(async () => { await pool.end(); });

const recs = async (student = me, limit = 12) =>
  (await pool.query("SELECT * FROM recommend_listings($1::int, $2::int)", [student, limit])).rows as { listing_id: number; reason: string; score: number }[];

describe("recommendations work WITHOUT embeddings (rule-based fallback)", () => {
  it("a student with no personal data still gets recently listed textbooks, newest first", async () => {
    const b1 = await makeBook(null), b2 = await makeBook(null);
    const l1 = await makeListing(seller, base.campus, b1, { title: "First" });
    const l2 = await makeListing(seller, base.campus, b2, { title: "Second" });
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM listing_embedding")).rows[0].n).toBe(0);
    const r = await recs();
    expect(r.map((x) => x.listing_id)).toEqual([l2, l1]);
    expect(r[0].reason).toBe("Available on your campus");
  });

  it("ranks course/department/semester matches first, then the rest", async () => {
    const sem5 = await makeBook(base.course2);   // CSE semester 5 = my department and semester
    const sem6 = await makeBook(base.course);    // CSE semester 6 = my department only
    const ece = (await one("INSERT INTO course (department_id, code, name, semester) VALUES ($1, 'EC1', 'Circuits', 5) RETURNING course_id", [base.dept2])).course_id;
    const other = await makeBook(ece);
    const lOther = await makeListing(seller, base.campus, other, { title: "Circuits" });
    const lSem6 = await makeListing(seller, base.campus, sem6, { title: "Sem6" });
    const lSem5 = await makeListing(seller, base.campus, sem5, { title: "Sem5" });
    const r = await recs();
    expect(r.map((x) => x.listing_id)).toEqual([lSem5, lSem6, lOther]);
    expect(r[0].reason).toBe("Matches your department and semester");
    expect(r[1].reason).toBe("Matches your department");
  });

  it("uses favorites and recent searches", async () => {
    const liked = await makeBook(null, { subject: "Poetry" });
    const likedCopy = await makeBook(null, { subject: "Poetry" });
    const searched = await makeBook(null, { subject: "Chemistry" });
    const plain = await makeBook(null, { subject: "Gardening" });
    const lLiked = await makeListing(seller, base.campus, liked, { title: "Liked" });
    const lCopy = await makeListing(seller, base.campus, likedCopy, { title: "Same subject as liked" });
    const lSearched = await makeListing(seller, base.campus, searched, { title: "Searched" });
    await makeListing(seller, base.campus, plain, { title: "Plain" });
    await pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2)", [me, lLiked]);
    await pool.query("INSERT INTO search_activity (student_id, query_text, search_type, book_id) VALUES ($1, 'chem', 'FULLTEXT', $2)", [me, searched]);
    const r = await recs();
    expect(r.map((x) => x.listing_id)).not.toContain(lLiked); // already a favorite
    expect(r.slice(0, 2).map((x) => x.listing_id).sort()).toEqual([lCopy, lSearched].sort());
    expect(r.find((x) => x.listing_id === lCopy)!.reason).toBe("Similar to your favorites");
    expect(r.find((x) => x.listing_id === lSearched)!.reason).toBe("Related to your activity");
  });

  it("prefers the student's own campus when nothing else decides", async () => {
    const campus2 = (await one("INSERT INTO campus (name, city) VALUES ('Far', 'Y') RETURNING campus_id")).campus_id;
    const dept2 = (await one("INSERT INTO department (campus_id, name) VALUES ($1, 'CSE') RETURNING department_id", [campus2])).department_id;
    const farSeller = await makeStudent({ dept: dept2 }, "Far");
    const far = await makeListing(farSeller, campus2, await makeBook(null), { title: "Far away" });
    const near = await makeListing(seller, base.campus, await makeBook(null), { title: "Near" });
    expect((await recs()).map((x) => x.listing_id)).toEqual([near, far]);
  });

  it("never recommends own, unavailable or removed listings, and respects the limit", async () => {
    const own = await makeListing(me, base.campus, await makeBook(base.course2));
    const sold = await makeListing(seller, base.campus, await makeBook(base.course2));
    const reserved = await makeListing(seller, base.campus, await makeBook(base.course2));
    const removed = await makeListing(seller, base.campus, await makeBook(base.course2));
    await pool.query("UPDATE listing SET status = 'SOLD' WHERE listing_id = $1", [sold]);
    await pool.query("UPDATE listing SET status = 'RESERVED' WHERE listing_id = $1", [reserved]);
    await pool.query("UPDATE listing SET status = 'REMOVED' WHERE listing_id = $1", [removed]);
    const ok = [];
    for (let i = 0; i < 4; i++) ok.push(await makeListing(seller, base.campus, await makeBook(null)));
    const r = await recs(me, 3);
    expect(r).toHaveLength(3);
    const all = (await recs()).map((x) => x.listing_id);
    for (const bad of [own, sold, reserved, removed]) expect(all).not.toContain(bad);
    expect(all.sort()).toEqual(ok.sort());
  });

  it("is empty only when nothing at all is available", async () => {
    await makeListing(me, base.campus, null);
    expect(await recs()).toEqual([]);
  });

  it("subject of a finished purchase counts as interest", async () => {
    const bought = await makeBook(null, { subject: "Astronomy" });
    const similar = await makeBook(null, { subject: "Astronomy" });
    const unrelated = await makeBook(null, { subject: "Law" });
    await completeSale(await makeListing(seller, base.campus, bought), me);
    await makeListing(seller, base.campus, unrelated, { title: "Law" });
    const l = await makeListing(seller, base.campus, similar, { title: "Astronomy 2" });
    expect((await recs())[0].listing_id).toBe(l);
  });
});
