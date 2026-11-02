import { beforeEach, describe, expect, it, afterAll } from "vitest";
import { pool, resetData, setupCampus, one } from "./helpers";
import { authenticate, findRegistrationConflicts, registerStudent } from "../lib/auth/service";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { signToken, verifyToken } from "../lib/auth/token";
import { registerSchema } from "../lib/validation/schemas";
import { REG_MSG, validateRegistration } from "../lib/validation/registration";
import { actionsFor, WHO_CAN_MOVE_TO } from "../lib/transactions";

process.env.SESSION_SECRET = "test-secret-test-secret-test-secret-1234";

let base: Awaited<ReturnType<typeof setupCampus>>;
const input = (over: Record<string, unknown> = {}) => ({
  srn: "PES1UG23CS999", name: "Asha Rao", email: "asha@test.local", password: "Passw0rdOK",
  departmentId: base.dept, semester: 4, ...over,
});

beforeEach(async () => { await resetData(); base = await setupCampus(); });
afterAll(async () => { await pool.end(); });

describe("registration", () => {
  it("stores a bcrypt hash, never the plaintext password", async () => {
    const { id } = await registerStudent(pool, input());
    const row = await one("SELECT password_hash FROM student WHERE student_id = $1", [id]);
    expect(row.password_hash).not.toContain("Passw0rdOK");
    expect(row.password_hash.startsWith("$2")).toBe(true);
    expect(await verifyPassword("Passw0rdOK", row.password_hash)).toBe(true);
  });

  it("rejects a duplicate e-mail or student ID (UNIQUE)", async () => {
    await registerStudent(pool, input());
    await expect(registerStudent(pool, input({ srn: "PES1UG23CS998" }))).rejects.toMatchObject({ code: "23505" });
    await expect(registerStudent(pool, input({ email: "other@test.local" }))).rejects.toMatchObject({ code: "23505" });
  });

  it("database rejects a bad semester and a malformed e-mail", async () => {
    await expect(registerStudent(pool, input({ semester: 9 }))).rejects.toMatchObject({ code: "23514" });
    await expect(registerStudent(pool, input({ semester: 0 }))).rejects.toMatchObject({ code: "23514" });
    await expect(registerStudent(pool, input({ email: "not-an-email" }))).rejects.toMatchObject({ code: "23514" });
    await expect(registerStudent(pool, input({ departmentId: 9999 }))).rejects.toThrow(/Unknown department|violates/);
  });

  it("accepts any valid e-mail (personal or college) and fills campus and the fixed B.Tech programme", async () => {
    const { id } = await registerStudent(pool, input({ email: "asha.personal@gmail.com" }));
    const row = await one("SELECT campus_id, program FROM student WHERE student_id = $1", [id]);
    expect(row).toMatchObject({ campus_id: base.campus, program: "B.Tech" });
    await expect(pool.query("UPDATE student SET program = 'M.Tech' WHERE student_id = $1", [id])).rejects.toMatchObject({ code: "23514" });
  });

  it("Zod rejects weak passwords and malformed IDs before the database is reached", () => {
    expect(registerSchema.safeParse({ ...input(), password: "short1" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...input(), password: "onlyletters" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...input(), srn: "ab" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...input(), semester: 9 }).success).toBe(false);
    expect(registerSchema.safeParse(input()).success).toBe(true);
  });
});

describe("registration uniqueness and messages", () => {
  const firstMessage = (data: Record<string, unknown>, field: string) => {
    const r = registerSchema.safeParse(data);
    return r.success ? null : r.error.issues.find((i) => i.path[0] === field)?.message ?? null;
  };

  it("existing SRN + new e-mail: only the SRN is reported", async () => {
    await registerStudent(pool, input());
    const err = await registerStudent(pool, input({ email: "new@test.local" })).catch((e) => e);
    expect(err.code).toBe("23505");
    expect(await findRegistrationConflicts(pool, "PES1UG23CS999", "new@test.local", err.constraint)).toEqual({ srn: true, email: false });
  });

  it("new SRN + existing e-mail: only the e-mail is reported", async () => {
    await registerStudent(pool, input());
    const err = await registerStudent(pool, input({ srn: "PES1UG23CS111" })).catch((e) => e);
    expect(err.code).toBe("23505");
    expect(await findRegistrationConflicts(pool, "PES1UG23CS111", "asha@test.local", err.constraint)).toEqual({ srn: false, email: true });
  });

  it("existing SRN + existing e-mail: both are reported", async () => {
    await registerStudent(pool, input());
    const err = await registerStudent(pool, input()).catch((e) => e);
    expect(err.code).toBe("23505");
    expect(await findRegistrationConflicts(pool, "PES1UG23CS999", "asha@test.local", err.constraint)).toEqual({ srn: true, email: true });
  });

  it("the same name and the same password are allowed for different students", async () => {
    await registerStudent(pool, input());
    await expect(registerStudent(pool, input({ srn: "PES1UG23CS222", email: "second@test.local" }))).resolves.toBeTruthy();
    const hashes = (await pool.query("SELECT password_hash FROM student")).rows.map((r) => r.password_hash);
    expect(new Set(hashes).size).toBe(2); // salted: same password, different hashes
  });

  it("e-mails are unique regardless of upper/lower case (the schema lower-cases, the database also forbids upper-case)", async () => {
    await registerStudent(pool, input());
    const parsed = registerSchema.parse(input({ srn: "pes1ug23cs333", email: "  ASHA@Test.Local " }));
    expect(parsed.email).toBe("asha@test.local");
    expect(parsed.srn).toBe("PES1UG23CS333");
    await expect(registerStudent(pool, parsed)).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query("UPDATE student SET email = 'ASHA@TEST.LOCAL'")).rejects.toMatchObject({ code: "23514" });
  });

  it("two identical concurrent registrations create exactly one account", async () => {
    const results = await Promise.allSettled([registerStudent(pool, input()), registerStudent(pool, input()), registerStudent(pool, input())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason.code).toBe("23505");
    expect((await one("SELECT COUNT(*)::int AS n FROM student")).n).toBe(1);
  });

  it("validation messages: missing, invalid SRN, invalid e-mail, weak password", () => {
    expect(firstMessage({ ...input(), srn: "" }, "srn")).toBe(REG_MSG.missing);
    expect(firstMessage({ ...input(), srn: "ab" }, "srn")).toBe(REG_MSG.invalidSrn);
    expect(firstMessage({ ...input(), email: "" }, "email")).toBe(REG_MSG.missing);
    expect(firstMessage({ ...input(), email: "not-an-email" }, "email")).toBe(REG_MSG.invalidEmail);
    expect(firstMessage({ ...input(), password: "short1" }, "password")).toBe(REG_MSG.weakPassword);
    expect(firstMessage({ ...input(), password: "onlyletters" }, "password")).toBe(REG_MSG.weakPassword);
    expect(firstMessage({ ...input(), password: undefined }, "password")).toBe(REG_MSG.missing);
    expect(firstMessage({ ...input(), name: undefined }, "name")).toBe(REG_MSG.missing);
  });

  it("the browser form check gives the same verdict as the API schema", () => {
    const form = { srn: "PES1UG23CS999", name: "Asha Rao", email: "asha@test.local", password: "Passw0rdOK", campusId: "1", departmentId: "1", semester: "4" };
    expect(validateRegistration(form)).toEqual({});
    expect(validateRegistration({ ...form, srn: "x" }).srn).toBe(REG_MSG.invalidSrn);
    expect(validateRegistration({ ...form, email: "bad" }).email).toBe(REG_MSG.invalidEmail);
    expect(validateRegistration({ ...form, password: "abc" }).password).toBe(REG_MSG.weakPassword);
    expect(validateRegistration({ ...form, name: "" }).name).toBe(REG_MSG.missing);
  });
});

describe("login and sessions", () => {
  it("accepts the right password and rejects a wrong one or an unknown e-mail", async () => {
    await registerStudent(pool, input());
    expect(await authenticate(pool, "STUDENT", "asha@test.local", "Passw0rdOK")).toMatchObject({ role: "STUDENT", name: "Asha Rao" });
    expect(await authenticate(pool, "STUDENT", "asha@test.local", "wrong-password1")).toBeNull();
    expect(await authenticate(pool, "STUDENT", "nobody@test.local", "Passw0rdOK")).toBeNull();
  });

  it("suspended students cannot log in", async () => {
    const { id } = await registerStudent(pool, input());
    await pool.query("UPDATE student SET status = 'SUSPENDED' WHERE student_id = $1", [id]);
    expect(await authenticate(pool, "STUDENT", "asha@test.local", "Passw0rdOK")).toBeNull();
  });

  it("admin login uses the admin table; a student cannot log in as admin", async () => {
    await pool.query("INSERT INTO admin (name, email, password_hash) VALUES ('Boss', 'boss@test.local', $1)", [await hashPassword("AdminPass1")]);
    expect(await authenticate(pool, "ADMIN", "boss@test.local", "AdminPass1")).toMatchObject({ role: "ADMIN" });
    await registerStudent(pool, input());
    expect(await authenticate(pool, "ADMIN", "asha@test.local", "Passw0rdOK")).toBeNull();
  });

  it("session tokens round-trip and reject tampering", async () => {
    const token = await signToken({ id: 7, role: "ADMIN", name: "Boss" });
    expect(await verifyToken(token)).toEqual({ id: 7, role: "ADMIN", name: "Boss" });
    expect(await verifyToken(token.slice(0, -2) + "xx")).toBeNull();
    expect(await verifyToken("garbage")).toBeNull();
  });
});

describe("authorization rules", () => {
  it("only the right party may request each transaction state", () => {
    expect(WHO_CAN_MOVE_TO.PAYMENT_HELD).toEqual(["buyer"]);
    expect(actionsFor("PENDING", "seller")).toEqual(["CANCELLED"]);
    expect(actionsFor("PENDING", "buyer")).toEqual(["PAYMENT_HELD", "CANCELLED"]);
    expect(actionsFor("HANDED_OFF", "seller")).toEqual([]);
    expect(actionsFor("CONFIRMED", "admin")).toEqual(["RELEASED"]);
  });
});
