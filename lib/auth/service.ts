// Registration and login against the database. `db` is a pg Pool or client, so tests can use their own.
import type { Pool, PoolClient, Client } from "pg";
import { hashPassword, verifyPassword } from "./password";
import type { Role } from "./token";
import { hashToken, newToken } from "./tokens";

type Db = Pool | PoolClient | Client;

export interface RegisterInput {
  srn: string;
  name: string;
  email: string;
  password: string;
  departmentId: number;
  semester: number;
}

// The database enforces: unique SRN/e-mail, SRN/e-mail format,
// semester 1-8, programme B.Tech, and fills the campus from the department.
export async function registerStudent(db: Db, input: RegisterInput): Promise<{ id: number }> {
  const passwordHash = await hashPassword(input.password);
  const res = await db.query(
    `INSERT INTO student (srn, name, email, password_hash, department_id, semester)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING student_id`,
    [input.srn, input.name, input.email, passwordHash, input.departmentId, input.semester]
  );
  return { id: res.rows[0].student_id as number };
}

// After a UNIQUE violation (23505): which of the two unique fields is taken? The constraint name from
// PostgreSQL (student_srn_key / student_email_key) tells which one failed FIRST; this lookup also finds out
// whether the other one is taken too (e.g. a repeated registration, or two identical concurrent requests).
// Only the database constraint decides whether an account may be created; this is just for the message.
export async function findRegistrationConflicts(db: Db, srn: string, email: string, constraint?: string): Promise<{ srn: boolean; email: boolean }> {
  const res = await db.query(
    "SELECT COALESCE(bool_or(srn = $1), false) AS srn, COALESCE(bool_or(email = $2), false) AS email FROM student WHERE srn = $1 OR email = $2",
    [srn, email]
  );
  const c = constraint ?? "";
  return {
    srn: !!res.rows[0].srn || /srn/i.test(c),
    email: !!res.rows[0].email || /email/i.test(c),
  };
}

// ---- password-reset tokens (hash stored, secret sent by e-mail) ----
export async function issueToken(db: Db, studentId: number, purpose: "VERIFY_EMAIL" | "RESET_PASSWORD", minutes: number): Promise<string> {
  const raw = newToken();
  await db.query("SELECT create_auth_token($1::int, $2::text, $3::text, $4::int)", [studentId, hashToken(raw), purpose, minutes]);
  return raw;
}

export async function resetPasswordWithToken(db: Db, rawToken: string, newPassword: string): Promise<number | null> {
  const newHash = await hashPassword(newPassword);
  const res = await db.query("SELECT reset_student_password($1::text, $2::text) AS id", [hashToken(rawToken), newHash]);
  return res.rows[0].id as number | null;
}

// A fixed dummy hash makes "unknown e-mail" take about as long as "wrong password".
const DUMMY_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.JrZLrPz3m1m0wXx9gZ0jJ8mQJ2he";

export async function authenticate(
  db: Db,
  role: Role,
  email: string,
  password: string
): Promise<{ id: number; name: string; role: Role } | null> {
  const sql =
    role === "ADMIN"
      ? "SELECT admin_id AS id, name, password_hash, 'ACTIVE' AS status FROM admin WHERE email = $1"
      : "SELECT student_id AS id, name, password_hash, status FROM student WHERE email = $1";
  const res = await db.query(sql, [email.trim().toLowerCase()]);
  const row = res.rows[0];
  const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_HASH);
  if (!row || !ok || row.status !== "ACTIVE") return null;
  return { id: row.id as number, name: row.name as string, role };
}
