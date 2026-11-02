// Server-side session helpers for route handlers. Every protected API route calls one of
// requireStudent / requireAdmin / requireUser, so authorization never depends on the UI.
import { cookies, headers } from "next/headers";
import { HttpError } from "../http";
import { queryOne } from "../db/pool";
import { COOKIE_NAME, SessionPayload, signToken, verifyToken } from "./token";

export async function getSession(): Promise<SessionPayload | null> {
  const token = cookies().get(COOKIE_NAME)?.value;
  return token ? verifyToken(token) : null;
}

export async function setSessionCookie(payload: SessionPayload) {
  const token = await signToken(payload);
  cookies().set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    // "secure" cookies are dropped by the browser on plain http (for example `npm start` on localhost),
    // which made the login look like it worked and then send the user straight back to the login page.
    secure: headers().get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookie() {
  cookies().set(COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });
}

// Logged-in student whose account still exists and is ACTIVE (suspended students are refused).
// E-mail verification is NOT required (removed); the session cookie + the account status are the checks.
export async function requireStudent(): Promise<{ id: number; name: string }> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Please log in");
  if (session.role !== "STUDENT") throw new HttpError(403, "Students only");
  const row = await queryOne<{ status: string }>("SELECT status FROM student WHERE student_id = $1", [session.id]);
  if (!row) throw new HttpError(401, "Account no longer exists");
  if (row.status !== "ACTIVE") throw new HttpError(403, "Your account is suspended");
  return { id: session.id, name: session.name };
}

export async function requireAdmin(): Promise<{ id: number; name: string }> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Please log in");
  if (session.role !== "ADMIN") throw new HttpError(403, "Admins only");
  const row = await queryOne("SELECT 1 FROM admin WHERE admin_id = $1", [session.id]);
  if (!row) throw new HttpError(401, "Account no longer exists");
  return { id: session.id, name: session.name };
}

export async function requireUser(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Please log in");
  if (session.role === "ADMIN") {
    await requireAdmin();
  } else {
    await requireStudent();
  }
  return session;
}
