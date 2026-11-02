// Registration rules shared by the browser form AND the API (Zod schema), so both always agree.
// The same SRN / e-mail patterns are also enforced by CHECK constraints in the database (002_constraints.sql).
// No server-only imports here: this file is used in client components too.

export const REG_MSG = {
  missing: "Please complete all required fields.",
  invalidSrn: "Please enter a valid Student ID.",
  invalidEmail: "Please enter a valid email address.",
  weakPassword: "Password does not meet the required security rules.",
  invalidName: "Please enter your full name.",
  invalidSemester: "Please choose a semester between 1 and 8.",
  srnTaken: "This Student ID is already registered. Please log in or use a different Student ID.",
  emailTaken: "This email address is already registered. Please log in or use a different email.",
  collegeEmailOnly: "Please use your college e-mail address.",
  bothTaken: "An account already exists with this Student ID and email. Please log in.",
  unavailable: "Registration is temporarily unavailable. Please try again later.",
  unexpected: "Something went wrong. Please try again.",
} as const;

export const SRN_PATTERN = /^[A-Z0-9]{8,20}$/; // after trim + upper-case
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/; // same idea as the database CHECK (lower-cased)

export const normalizeSrn = (v: string) => v.trim().toUpperCase();
export const normalizeEmail = (v: string) => v.trim().toLowerCase();
export const passwordIsStrong = (v: string) => v.length >= 8 && v.length <= 72 && /[A-Za-z]/.test(v) && /[0-9]/.test(v);

export type RegField = "srn" | "name" | "email" | "password" | "campusId" | "departmentId" | "semester";

// Browser-side check with exactly the same rules and messages as the API. Returns { field: message }.
export function validateRegistration(f: Record<RegField, string>): Partial<Record<RegField, string>> {
  const e: Partial<Record<RegField, string>> = {};
  const srn = normalizeSrn(f.srn);
  const name = f.name.trim();
  const email = normalizeEmail(f.email);
  if (!srn) e.srn = REG_MSG.missing;
  else if (!SRN_PATTERN.test(srn)) e.srn = REG_MSG.invalidSrn;
  if (!name) e.name = REG_MSG.missing;
  else if (name.length < 2 || name.length > 100) e.name = REG_MSG.invalidName;
  if (!email) e.email = REG_MSG.missing;
  else if (!EMAIL_PATTERN.test(email) || email.length > 200) e.email = REG_MSG.invalidEmail;
  if (!f.password) e.password = REG_MSG.missing;
  else if (!passwordIsStrong(f.password)) e.password = REG_MSG.weakPassword;
  if (!f.campusId) e.campusId = REG_MSG.missing;
  if (!f.departmentId) e.departmentId = REG_MSG.missing;
  const sem = Number(f.semester);
  if (!f.semester) e.semester = REG_MSG.missing;
  else if (!Number.isInteger(sem) || sem < 1 || sem > 8) e.semester = REG_MSG.invalidSemester;
  return e;
}
