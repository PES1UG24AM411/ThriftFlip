import { handle } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";

export const POST = handle(async () => {
  await requireAdmin();
  const rows = await query("SELECT close_expired_auctions() AS closed");
  return { closed: rows[0].closed };
});

export const dynamic = "force-dynamic";
