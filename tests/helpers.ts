// Test helpers: one pool for the test database and small factories that insert rows with plain SQL.
import { Pool } from "pg";
import { assertConnectedToTestDatabase, resolveTestDatabaseUrl } from "./testEnv";

// Same safety checks as globalSetup: never a development, production or remote database.
export const pool = new Pool({ connectionString: resolveTestDatabaseUrl(), max: 5 });

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

let counter = 0;
const FAKE_HASH = "$2b$10$" + "x".repeat(53); // 60 characters, passes the length CHECK

export async function resetData() {
  await assertConnectedToTestDatabase(pool); // asks the server which database this really is, before deleting anything
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'"))
    .rows.map((r) => `"${r.tablename}"`);
  await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
  counter = 0;
}

export async function one<T = any>(sql: string, params: unknown[] = []): Promise<T> {
  return (await pool.query(sql, params)).rows[0] as T;
}

export async function setupCampus() {
  await pool.query("INSERT INTO college_email_domain (domain) VALUES ('test.local')");
  const campus = (await one("INSERT INTO campus (name, city) VALUES ('Main', 'Bengaluru') RETURNING campus_id")).campus_id;
  const dept = (await one("INSERT INTO department (campus_id, name) VALUES ($1, 'CSE') RETURNING department_id", [campus])).department_id;
  const dept2 = (await one("INSERT INTO department (campus_id, name) VALUES ($1, 'ECE') RETURNING department_id", [campus])).department_id;
  const course = (await one("INSERT INTO course (department_id, code, name, semester) VALUES ($1, 'CS100', 'Machine Learning', 6) RETURNING course_id", [dept])).course_id;
  const course2 = (await one("INSERT INTO course (department_id, code, name, semester) VALUES ($1, 'CS200', 'Databases', 5) RETURNING course_id", [dept])).course_id;
  return { campus, dept, dept2, course, course2 };
}

// Students are created in the given department, semester 3 unless stated.
export async function makeStudent(base: { dept: number }, name = "Student", semester = 3) {
  counter++;
  return (await one(
    `INSERT INTO student (srn, name, email, password_hash, department_id, semester)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING student_id`,
    [`TST${String(counter).padStart(6, "0")}`, `${name} ${counter}`, `user${counter}@test.local`, FAKE_HASH, base.dept, semester]
  )).student_id as number;
}

export async function makeBook(courseId: number | null, o: { title?: string; author?: string; subject?: string; edition?: number } = {}) {
  counter++;
  return (await one(
    "INSERT INTO book (isbn, title, author, edition, subject, course_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING book_id",
    [`97800000${String(counter).padStart(5, "0")}`, o.title ?? `Book ${counter}`, o.author ?? "Author", o.edition ?? 1, o.subject ?? "Machine Learning", courseId]
  )).book_id as number;
}

export async function makeListing(
  sellerId: number,
  campusId: number,
  bookId: number | null,
  o: { title?: string; price?: number; cond?: string; type?: string; swap?: boolean; description?: string } = {}
) {
  return (await one(
    `INSERT INTO listing (seller_id, book_id, campus_id, category, title, description, item_condition, listing_type, price, open_to_swap)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING listing_id`,
    [sellerId, bookId, campusId, bookId ? "TEXTBOOK" : "GOODS", o.title ?? "Test listing", o.description ?? "", o.cond ?? "GOOD",
     o.type ?? "FIXED_PRICE", o.price ?? 100, o.swap ?? false]
  )).listing_id as number;
}

export async function makeAuction(listingId: number, start: Date, end: Date, minIncrement = 10) {
  const price = (await one("SELECT price FROM listing WHERE listing_id = $1", [listingId])).price;
  return (await one(
    "INSERT INTO auction (listing_id, starting_price, min_increment, start_time, end_time) VALUES ($1, $2, $3, $4, $5) RETURNING auction_id",
    [listingId, price, minIncrement, start, end]
  )).auction_id as number;
}

export const placeBid = (auctionId: number, bidderId: number, amount: number, at?: Date) =>
  pool.query("SELECT * FROM place_bid($1::int, $2::int, $3::numeric, COALESCE($4::timestamptz, now()))", [auctionId, bidderId, amount, at ?? null]);

export const move = (txId: number, state: string, actorType = "STUDENT", actorId: number | null = null) =>
  pool.query("SELECT transition_transaction($1::int, $2::text, $3::text, $4::int)", [txId, state, actorType, actorId]);

// Completes a fixed-price sale: PENDING -> ... -> RELEASED (so it counts as price history).
export async function completeSale(listingId: number, buyerId: number, finalState = "RELEASED") {
  const txId = (await one("SELECT create_purchase($1::int, $2::int) AS id", [listingId, buyerId])).id as number;
  for (const s of ["PAYMENT_HELD", "HANDED_OFF", "CONFIRMED", "RELEASED"]) {
    await move(txId, s);
    if (s === finalState) break;
  }
  return txId;
}

// 384-number vector literal for pgvector tests: first components given, the rest zero.
export function vec(...head: number[]): string {
  const v = new Array(384).fill(0);
  head.forEach((x, i) => (v[i] = x));
  return `[${v.join(",")}]`;
}
