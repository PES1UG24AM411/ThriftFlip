import { handle, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";

export const GET = handle(async (req) => {
  await requireAdmin();
  const level = searchParams(req).get("level") ?? "";
  return query(
    `SELECT * FROM v_bid_risk WHERE ($1 = '' OR risk_level = $1) ORDER BY risk_score DESC, bidder_name LIMIT 100`,
    [["NORMAL", "SUSPICIOUS", "HIGH_RISK"].includes(level) ? level : ""]
  );
});

export const dynamic = "force-dynamic";
