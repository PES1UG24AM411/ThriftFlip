// Passwords are hashed with bcrypt (salted, cost 10). Plaintext passwords are never stored or logged.
import bcrypt from "bcryptjs"; // pure JavaScript: nothing to compile, works on every OS and Node version

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
