import { handle } from "@/lib/http";
import { clearSessionCookie } from "@/lib/auth/session";

export const POST = handle(async () => {
  clearSessionCookie();
  return { ok: true };
});

export const dynamic = "force-dynamic";
