import { handle, parseBody, HttpError } from "@/lib/http";
import { pool } from "@/lib/db/pool";
import { loginSchema } from "@/lib/validation/schemas";
import { authenticate } from "@/lib/auth/service";
import { setSessionCookie } from "@/lib/auth/session";

export const POST = handle(async (req) => {
  const { email, password, role } = await parseBody(req, loginSchema);
  const user = await authenticate(pool, role, email, password);
  if (!user) throw new HttpError(401, "Wrong e-mail or password");
  await setSessionCookie(user);
  return { ok: true, role: user.role };
});

export const dynamic = "force-dynamic";
