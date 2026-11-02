import { handle, HttpError, parseBody } from "@/lib/http";
import { pool } from "@/lib/db/pool";
import { resetSchema } from "@/lib/validation/schemas";
import { resetPasswordWithToken } from "@/lib/auth/service";

export const POST = handle(async (req) => {
  const { token, password } = await parseBody(req, resetSchema);
  const id = await resetPasswordWithToken(pool, token, password);
  if (!id) throw new HttpError(400, "This reset link is invalid, already used or expired");
  return { ok: true };
});

export const dynamic = "force-dynamic";
