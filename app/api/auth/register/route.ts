import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError, parseBody, setupProblem } from "@/lib/http";
import { pool } from "@/lib/db/pool";
import { registerSchema } from "@/lib/validation/schemas";
import { REG_MSG } from "@/lib/validation/registration";
import { findRegistrationConflicts, registerStudent } from "@/lib/auth/service";
import { setSessionCookie } from "@/lib/auth/session";
import { allowedEmailDomains, collegeEmailMessage, isEmailAllowed } from "@/lib/auth/emailPolicy";

// Creates the account and logs the student in at once: there is NO e-mail verification step and no SMTP is needed.
// Any valid e-mail address is accepted unless COLLEGE_EMAIL_DOMAINS is set (see lib/auth/emailPolicy.ts).
//
// Uniqueness is enforced by the database (UNIQUE on student.srn and student.email; both values are
// normalised first: SRN trimmed + upper-case, e-mail trimmed + lower-case). When PostgreSQL reports
// 23505 we work out WHICH field clashed and answer with a specific message.
// Error body: { error, code, fields? }  where fields = { srn?: message, email?: message, ... }
type Fields = Record<string, string>;
const fail = (status: number, code: string, error: string, fields?: Fields) =>
  NextResponse.json({ error, code, ...(fields ? { fields } : {}) }, { status });

export async function POST(req: Request) {
  let srn = "";
  let email = "";
  try {
    const input = await parseBody(req, registerSchema);
    srn = input.srn;
    email = input.email;
    const domains = allowedEmailDomains();
    if (!isEmailAllowed(input.email, domains)) {
      return fail(400, "EMAIL_DOMAIN_NOT_ALLOWED", collegeEmailMessage(domains), { email: collegeEmailMessage(domains) });
    }
    const { id } = await registerStudent(pool, input); // single INSERT: UNIQUE constraints decide duplicates
    await setSessionCookie({ id, role: "STUDENT", name: input.name });
    return NextResponse.json({ ok: true, email: input.email }, { status: 201 });
  } catch (err) {
    return registrationError(err, srn, email);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function registrationError(err: any, srn: string, email: string) {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message, code: "BAD_REQUEST" }, { status: err.status });

  if (err instanceof ZodError) {
    const fields: Fields = {};
    for (const issue of err.issues) {
      const key = String(issue.path[0] ?? "form");
      if (!fields[key]) fields[key] = issue.message; // first (most important) message per field
    }
    const messages = Object.values(fields);
    const error = messages.every((m) => m === REG_MSG.missing) ? REG_MSG.missing : messages.find((m) => m !== REG_MSG.missing) ?? REG_MSG.missing;
    return fail(400, "VALIDATION_ERROR", error, fields);
  }

  if (err?.code === "23505") {
    // The unique constraint stopped it (also for two identical requests at the same time: exactly one wins).
    let found = { srn: /srn/i.test(err.constraint ?? ""), email: /email/i.test(err.constraint ?? "") };
    try {
      found = await findRegistrationConflicts(pool, srn, email, err.constraint);
    } catch (e) {
      console.error("[register] conflict lookup failed", e);
    }
    if (found.srn && found.email) {
      return fail(409, "ACCOUNT_EXISTS", REG_MSG.bothTaken, { srn: "This Student ID is already registered.", email: "This email address is already registered." });
    }
    if (found.srn) return fail(409, "SRN_EXISTS", REG_MSG.srnTaken, { srn: REG_MSG.srnTaken });
    if (found.email) return fail(409, "EMAIL_EXISTS", REG_MSG.emailTaken, { email: REG_MSG.emailTaken });
    console.error("[register] unique violation on unexpected constraint", err.constraint);
    return fail(500, "UNEXPECTED", REG_MSG.unexpected);
  }

  if (err?.code === "23514") {
    // CHECK constraint (the schema normally catches these first)
    const c = String(err.constraint ?? "");
    if (c === "ck_student_srn") return fail(400, "VALIDATION_ERROR", REG_MSG.invalidSrn, { srn: REG_MSG.invalidSrn });
    if (c === "ck_student_email") return fail(400, "VALIDATION_ERROR", REG_MSG.invalidEmail, { email: REG_MSG.invalidEmail });
  }

  // Database down, wrong credentials, tables missing, ...: details go to the server log only, never to the user.
  const unavailable =
    !process.env.DATABASE_URL ||
    ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "28P01", "28000", "3D000", "42P01", "42703", "42883", "53300", "57P01", "57P02", "57P03"].includes(err?.code) ||
    String(err?.code ?? "").startsWith("08");
  console.error("[register]", unavailable ? setupProblem(err) ?? err : err);
  return unavailable ? fail(503, "SERVICE_UNAVAILABLE", REG_MSG.unavailable) : fail(500, "UNEXPECTED", REG_MSG.unexpected);
}

export const dynamic = "force-dynamic";
