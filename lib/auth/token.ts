// Signed session token (JWT, HS256) stored in an httpOnly cookie. Uses only `jose`, so the
// Next.js middleware (edge runtime) can import it too.
import { SignJWT, jwtVerify } from "jose";

export type Role = "STUDENT" | "ADMIN";
export interface SessionPayload {
  id: number;
  role: Role;
  name: string;
}
export const COOKIE_NAME = "tf_session";

function secretKey(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set (at least 32 characters)");
  return new TextEncoder().encode(secret);
}

export async function signToken(p: SessionPayload): Promise<string> {
  return new SignJWT({ role: p.role, name: p.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(p.id))
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secretKey());
}

export async function verifyToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    const id = Number(payload.sub);
    const role = payload.role;
    if (!Number.isInteger(id) || id <= 0) return null;
    if (role !== "STUDENT" && role !== "ADMIN") return null;
    return { id, role, name: String(payload.name ?? "") };
  } catch {
    return null;
  }
}
