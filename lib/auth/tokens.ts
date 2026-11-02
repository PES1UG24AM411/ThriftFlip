// Random secret tokens for e-mail verification and password reset.
// Only the SHA-256 hash is stored in the database, so a leaked database cannot be used to verify or reset accounts.
import { createHash, randomBytes } from "node:crypto";

export const newToken = (): string => randomBytes(32).toString("hex");
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
