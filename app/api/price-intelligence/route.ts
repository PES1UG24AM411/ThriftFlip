import { handle, HttpError, parseId, searchParams } from "@/lib/http";
import { queryOne } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";

const CONDITIONS = ["NEW", "LIKE_NEW", "GOOD", "FAIR", "POOR"];

export const GET = handle(async (req) => {
  await requireStudent();
  const sp = searchParams(req);
  const bookId = parseId(sp.get("bookId"), "bookId");
  const condition = sp.get("condition") ?? "GOOD";
  if (!CONDITIONS.includes(condition)) throw new HttpError(400, "Invalid condition");

  const fairPrice = await queryOne("SELECT * FROM calculate_fair_price($1::int, $2::text)", [bookId, condition]);
  const current = await queryOne(
    `SELECT COUNT(*)::int AS active_listings, MIN(price) AS min_price,
            ROUND(AVG(price), 2) AS avg_price, MAX(price) AS max_price
     FROM listing WHERE book_id = $1 AND status = 'ACTIVE' AND listing_type = 'FIXED_PRICE'`,
    [bookId]
  );
  const demand = await queryOne("SELECT demand_score, demand_level FROM v_book_demand WHERE book_id = $1", [bookId]);
  return { fairPrice, currentListings: current, demand };
});

export const dynamic = "force-dynamic";
