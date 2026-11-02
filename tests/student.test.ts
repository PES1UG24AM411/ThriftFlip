import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, makeStudent, makeBook, makeListing, one, completeSale } from "./helpers";
import { issueToken, registerStudent, resetPasswordWithToken, authenticate } from "../lib/auth/service";
import { hashToken } from "../lib/auth/tokens";
import { readImage } from "../lib/images";
import { listingCreateSchema, profileUpdateSchema } from "../lib/validation/schemas";

let base: Awaited<ReturnType<typeof setupCampus>>;
beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

const register = (over: Record<string, unknown> = {}) =>
  registerStudent(pool, { srn: "PES1UG23CS500", name: "Nila", email: "nila@test.local", password: "Passw0rd1", departmentId: base.dept, semester: 1, ...over } as any);

describe("registration needs no e-mail verification", () => {
  it("a new student can use the account at once: nothing is sent or required, any valid e-mail is stored", async () => {
    const { id } = await register({ email: "nila.personal@gmail.com" });
    expect((await one("SELECT status FROM student WHERE student_id = $1", [id])).status).toBe("ACTIVE");
    expect(await authenticate(pool, "STUDENT", "nila.personal@gmail.com", "Passw0rd1")).toMatchObject({ id });
    expect((await one("SELECT COUNT(*)::int AS n FROM auth_token")).n).toBe(0); // no verification token is created
  });

  it("the e-mail format is still checked, and changing the e-mail needs no verification", async () => {
    const { id } = await register();
    await pool.query("UPDATE student SET email = 'nila@yahoo.com' WHERE student_id = $1", [id]);
    await expect(pool.query("UPDATE student SET email = 'not-an-email' WHERE student_id = $1", [id])).rejects.toMatchObject({ code: "23514" });
  });
});

describe("password-reset tokens", () => {
  it("only the hash of the token is stored, and an expired token is refused", async () => {
    const { id } = await register();
    const token = await issueToken(pool, id, "RESET_PASSWORD", 60);
    const rows = (await pool.query("SELECT token_hash FROM auth_token")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(rows[0].token_hash).not.toBe(token);
    await pool.query("UPDATE auth_token SET expires_at = now() - interval '1 minute'");
    expect(await resetPasswordWithToken(pool, token, "NewPassw0rd9")).toBeNull();
  });

  it("a token of another purpose cannot reset the password, and a new reset token replaces the old one", async () => {
    const { id } = await register();
    const other = await issueToken(pool, id, "VERIFY_EMAIL", 60);
    expect(await resetPasswordWithToken(pool, other, "NewPassw0rd9")).toBeNull();
    const first = await issueToken(pool, id, "RESET_PASSWORD", 60);
    const second = await issueToken(pool, id, "RESET_PASSWORD", 60);
    expect(await resetPasswordWithToken(pool, first, "NewPassw0rd9")).toBeNull(); // replaced
    expect(await resetPasswordWithToken(pool, second, "NewPassw0rd9")).toBe(id);
  });
});

describe("campus and department", () => {
  it("the same department name can exist on every campus, and the student's campus follows the department", async () => {
    const campus2 = (await one("INSERT INTO campus (name, city) VALUES ('EC', 'Bengaluru') RETURNING campus_id")).campus_id;
    const cseEc = (await one("INSERT INTO department (campus_id, name) VALUES ($1, 'CSE') RETURNING department_id", [campus2])).department_id;
    await expect(pool.query("INSERT INTO department (campus_id, name) VALUES ($1, 'CSE')", [campus2])).rejects.toMatchObject({ code: "23505" });
    const onFirst = await register({ srn: "PES1UG23CS610", email: "c1@test.local" });
    const onSecond = await register({ srn: "PES2UG23CS611", email: "c2@test.local", departmentId: cseEc });
    expect((await one("SELECT campus_id FROM student WHERE student_id = $1", [onFirst.id])).campus_id).toBe(base.campus);
    expect((await one("SELECT campus_id FROM student WHERE student_id = $1", [onSecond.id])).campus_id).toBe(campus2);
  });

  it("changing the department (first year) moves the student to that department's campus", async () => {
    const campus2 = (await one("INSERT INTO campus (name, city) VALUES ('EC', 'Bengaluru') RETURNING campus_id")).campus_id;
    const eceEc = (await one("INSERT INTO department (campus_id, name) VALUES ($1, 'ECE') RETURNING department_id", [campus2])).department_id;
    const { id } = await register({ semester: 1, srn: "PES1UG23CS612", email: "c3@test.local" });
    await pool.query("UPDATE student SET department_id = $2 WHERE student_id = $1", [id, eceEc]);
    expect((await one("SELECT campus_id FROM student WHERE student_id = $1", [id])).campus_id).toBe(campus2);
  });
});

describe("password reset", () => {
  it("a reset link sets a new password once; the old password stops working", async () => {
    const { id } = await register();
    const token = await issueToken(pool, id, "RESET_PASSWORD", 60);
    expect(await resetPasswordWithToken(pool, token, "BrandNew123")).toBe(id);
    expect(await authenticate(pool, "STUDENT", "nila@test.local", "BrandNew123")).toMatchObject({ id });
    expect(await authenticate(pool, "STUDENT", "nila@test.local", "Passw0rd1")).toBeNull();
    expect(await resetPasswordWithToken(pool, token, "AnotherOne456")).toBeNull(); // single use
  });

  it("an expired reset link is refused", async () => {
    const { id } = await register();
    const token = await issueToken(pool, id, "RESET_PASSWORD", 60);
    await pool.query("UPDATE auth_token SET expires_at = now() - interval '1 second'");
    expect(await resetPasswordWithToken(pool, token, "BrandNew123")).toBeNull();
    expect(await authenticate(pool, "STUDENT", "nila@test.local", "Passw0rd1")).toMatchObject({ id });
  });
});

describe("profile management rules", () => {
  it("semester can go up but never backwards; the cap is 8", async () => {
    const { id } = await register({ semester: 3 });
    await pool.query("UPDATE student SET semester = 4 WHERE student_id = $1", [id]);
    await expect(pool.query("UPDATE student SET semester = 3 WHERE student_id = $1", [id])).rejects.toThrow(/backwards/);
    await expect(pool.query("UPDATE student SET semester = 9 WHERE student_id = $1", [id])).rejects.toMatchObject({ code: "23514" });
  });

  it("the department can only be changed in the first year", async () => {
    const first = await register({ semester: 2, srn: "PES1UG23CS501", email: "a1@test.local" });
    await pool.query("UPDATE student SET department_id = $2 WHERE student_id = $1", [first.id, base.dept2]);
    expect((await one("SELECT department_id FROM student WHERE student_id = $1", [first.id])).department_id).toBe(base.dept2);
    const senior = await register({ semester: 5, srn: "PES1UG23CS502", email: "a2@test.local" });
    await expect(pool.query("UPDATE student SET department_id = $2 WHERE student_id = $1", [senior.id, base.dept2])).rejects.toThrow(/first year/);
  });

  it("contact preferences: PHONE needs a valid number; the profile schema validates input", async () => {
    const { id } = await register();
    await expect(pool.query("UPDATE student SET contact_preference = 'PHONE' WHERE student_id = $1", [id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE student SET phone = '12ab' WHERE student_id = $1", [id])).rejects.toMatchObject({ code: "23514" });
    await pool.query("UPDATE student SET contact_preference = 'PHONE', phone = '+919876543210', show_contact = true WHERE student_id = $1", [id]);
    expect(profileUpdateSchema.safeParse({ phone: "abc" }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ semester: 9 }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ contactPreference: "FAX" }).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ semester: 4, phone: null, showContact: true }).success).toBe(true);
  });
});

describe("profile photo and book photos", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

  it("readImage accepts JPEG/PNG/WebP, detects the type from the bytes and rejects other files and big files", async () => {
    expect((await readImage(new File([png], "a.png", { type: "text/plain" }))).contentType).toBe("image/png");
    expect((await readImage(new File([jpg], "a.jpg"))).contentType).toBe("image/jpeg");
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]);
    expect((await readImage(new File([webp], "a.webp"))).contentType).toBe("image/webp");
    await expect(readImage(new File([Buffer.from("<html>")], "a.png", { type: "image/png" }))).rejects.toThrow(/Only JPEG/);
    await expect(readImage(new File([Buffer.alloc(3 * 1024 * 1024)], "big.jpg"))).rejects.toThrow(/2 MB/);
  });

  const insertImage = (owner: number, purpose: string, data = png) =>
    one("INSERT INTO image (owner_id, purpose, content_type, size_bytes, data) VALUES ($1, $2, 'image/png', $3, $4) RETURNING image_id", [owner, purpose, data.length, data]);

  it("a student has one profile photo only (unique index)", async () => {
    const s = await makeStudent(base);
    await insertImage(s, "PROFILE");
    await expect(insertImage(s, "PROFILE")).rejects.toMatchObject({ code: "23505" });
  });

  it("a listing holds at most 5 photos, only from its seller, and the first one is the cover", async () => {
    const seller = await makeStudent(base), other = await makeStudent(base);
    const listing = await makeListing(seller, base.campus, await makeBook(base.course));
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const img = await insertImage(seller, "LISTING");
      ids.push(img.image_id);
      await pool.query("INSERT INTO listing_image (listing_id, image_id, position) VALUES ($1, $2, $3)", [listing, img.image_id, i]);
    }
    const sixth = await insertImage(seller, "LISTING");
    await expect(pool.query("INSERT INTO listing_image (listing_id, image_id, position) VALUES ($1, $2, 0)", [listing, sixth.image_id])).rejects.toThrow(/at most 5/);
    const foreign = await insertImage(other, "LISTING");
    const l2 = await makeListing(seller, base.campus, null);
    await expect(pool.query("INSERT INTO listing_image (listing_id, image_id, position) VALUES ($1, $2, 0)", [l2, foreign.image_id])).rejects.toThrow(/uploaded by the seller/);
    expect((await one("SELECT cover_image_id FROM v_listing_details WHERE listing_id = $1", [listing])).cover_image_id).toBe(ids[0]);
  });

  it("images are removed together with their listing photo link (cascade)", async () => {
    const seller = await makeStudent(base);
    const listing = await makeListing(seller, base.campus, null);
    const img = await insertImage(seller, "LISTING");
    await pool.query("INSERT INTO listing_image (listing_id, image_id, position) VALUES ($1, $2, 0)", [listing, img.image_id]);
    await pool.query("DELETE FROM image WHERE image_id = $1", [img.image_id]);
    expect((await one("SELECT COUNT(*)::int AS n FROM listing_image")).n).toBe(0);
  });
});

describe("selling books: schema, search filters and ISBN", () => {
  it("listing form schema: textbook needs an author, ISBN is normalised and validated", () => {
    const ok = { title: "Algorithms", author: "CLRS", condition: "GOOD", price: 300 };
    expect(listingCreateSchema.safeParse(ok).success).toBe(true);
    expect(listingCreateSchema.safeParse({ ...ok, author: undefined }).success).toBe(false);
    const withIsbn = listingCreateSchema.parse({ ...ok, isbn: "978-0-262-04630-5" });
    expect(withIsbn.isbn).toBe("9780262046305");
    expect(listingCreateSchema.safeParse({ ...ok, isbn: "12345" }).success).toBe(false);
    expect(listingCreateSchema.parse({ ...ok, isbn: "" }).isbn).toBeUndefined();
    expect(listingCreateSchema.safeParse({ title: "Calculator", category: "GOODS", condition: "GOOD", price: 100 }).success).toBe(true);
  });

  it("ISBN-10 may end with X; other characters are rejected by the database", async () => {
    await pool.query("INSERT INTO book (isbn, title, author, subject) VALUES ('080442957X', 'T', 'A', 'S')");
    await expect(pool.query("INSERT INTO book (isbn, title, author, subject) VALUES ('12345', 'T', 'A', 'S')")).rejects.toMatchObject({ code: "23514" });
  });

  it("filters by department, semester, course code, ISBN, price and condition use the view's columns", async () => {
    const seller = await makeStudent(base);
    const ml = await makeBook(base.course, { title: "ML book" });          // CSE, semester 6, CS100
    const db = await makeBook(base.course2, { title: "DB book" });          // CSE, semester 5, CS200
    await pool.query("UPDATE book SET isbn = '9780000000011' WHERE book_id = $1", [ml]);
    const lMl = await makeListing(seller, base.campus, ml, { price: 400, cond: "GOOD" });
    const lDb = await makeListing(seller, base.campus, db, { price: 900, cond: "FAIR" });
    const none = await makeListing(seller, base.campus, null, { price: 50 });
    const find = async (where: string, params: unknown[] = []) =>
      (await pool.query(`SELECT listing_id FROM v_listing_details d WHERE d.status = 'ACTIVE' AND ${where} ORDER BY listing_id`, params)).rows.map((r) => r.listing_id);
    expect(await find("d.department_id = $1", [base.dept])).toEqual([lMl, lDb]);
    expect(await find("d.department_id = $1", [base.dept2])).toEqual([]);
    expect(await find("d.course_semester = $1", [6])).toEqual([lMl]);
    expect(await find("upper(d.course_code) = $1", ["CS200"])).toEqual([lDb]);
    expect(await find("d.isbn = $1", ["9780000000011"])).toEqual([lMl]);
    expect(await find("d.current_price BETWEEN 100 AND 500")).toEqual([lMl]);
    expect(await find("d.item_condition = 'FAIR'")).toEqual([lDb]);
    expect(none).toBeGreaterThan(0);
  });

  it("the ISBN is part of the full-text document", async () => {
    const seller = await makeStudent(base);
    const book = await makeBook(base.course);
    await pool.query("UPDATE book SET isbn = '9780000000028' WHERE book_id = $1", [book]);
    const l = await makeListing(seller, base.campus, book);
    const hit = await pool.query("SELECT 1 FROM listing WHERE listing_id = $1 AND search_vector @@ websearch_to_tsquery('english', '9780000000028')", [l]);
    expect(hit.rowCount).toBe(1);
  });
});

describe("mark as sold", () => {
  it("the seller marks a book as sold: it leaves the active list, offers are rejected, favorites are told", async () => {
    const seller = await makeStudent(base), fan = await makeStudent(base), bidder = await makeStudent(base);
    const listing = await makeListing(seller, base.campus, await makeBook(base.course), { price: 200 });
    await pool.query("INSERT INTO wishlist (student_id, listing_id) VALUES ($1, $2)", [fan, listing]);
    await pool.query("INSERT INTO offer (listing_id, buyer_id, amount) VALUES ($1, $2, 150)", [listing, bidder]);
    await pool.query("SELECT mark_listing_sold($1::int, $2::int)", [listing, seller]);
    expect((await one("SELECT status FROM listing WHERE listing_id = $1", [listing])).status).toBe("SOLD");
    expect((await one("SELECT COUNT(*)::int AS n FROM v_listing_details WHERE status = 'ACTIVE' AND listing_id = $1", [listing])).n).toBe(0);
    expect((await one("SELECT status FROM offer WHERE listing_id = $1", [listing])).status).toBe("REJECTED");
    expect((await one("SELECT COUNT(*)::int AS n FROM notification WHERE student_id = $1 AND type = 'LISTING_SOLD'", [fan])).n).toBe(1);
    await expect(pool.query("SELECT create_purchase($1::int, $2::int)", [listing, bidder])).rejects.toThrow(/not available/);
  });

  it("only the seller can do it, only once, only for active fixed-price listings", async () => {
    const seller = await makeStudent(base), other = await makeStudent(base);
    const listing = await makeListing(seller, base.campus, null);
    await expect(pool.query("SELECT mark_listing_sold($1::int, $2::int)", [listing, other])).rejects.toThrow(/Only the seller/);
    await pool.query("SELECT mark_listing_sold($1::int, $2::int)", [listing, seller]);
    await expect(pool.query("SELECT mark_listing_sold($1::int, $2::int)", [listing, seller])).rejects.toThrow(/Only active/);
    const auction = await makeListing(seller, base.campus, null, { type: "AUCTION" });
    await expect(pool.query("SELECT mark_listing_sold($1::int, $2::int)", [auction, seller])).rejects.toThrow(/fixed-price/);
    const reserved = await makeListing(seller, base.campus, null);
    await completeSale(reserved, other, "PAYMENT_HELD");
    await expect(pool.query("SELECT mark_listing_sold($1::int, $2::int)", [reserved, seller])).rejects.toThrow(/Only active/);
  });
});

describe("recently viewed", () => {
  it("remembers viewed listings, newest first, one row per listing", async () => {
    const seller = await makeStudent(base), me = await makeStudent(base);
    const a = await makeListing(seller, base.campus, null), b = await makeListing(seller, base.campus, null);
    const view = (l: number) => pool.query("SELECT touch_recently_viewed($1::int, $2::int)", [me, l]);
    await view(a); await view(b); await view(a);
    const rows = (await pool.query("SELECT listing_id FROM recently_viewed WHERE student_id = $1 ORDER BY viewed_at DESC", [me])).rows.map((r) => r.listing_id);
    expect(rows).toEqual([a, b]);
  });

  it("keeps only the 20 most recent listings", async () => {
    const seller = await makeStudent(base), me = await makeStudent(base);
    const ids: number[] = [];
    for (let i = 0; i < 23; i++) {
      const l = await makeListing(seller, base.campus, null);
      ids.push(l);
      await pool.query("SELECT touch_recently_viewed($1::int, $2::int)", [me, l]);
    }
    const kept = (await pool.query("SELECT listing_id FROM recently_viewed WHERE student_id = $1", [me])).rows.map((r) => r.listing_id);
    expect(kept).toHaveLength(20);
    expect(kept).not.toContain(ids[0]);
    expect(kept).toContain(ids[22]);
  });
});
