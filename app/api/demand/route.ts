import { handle } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireUser } from "@/lib/auth/session";

export const GET = handle(async () => {
  await requireUser();
  const books = await query(
    `SELECT book_id, title, edition, wishlist_count, search_count_30d, bid_count, swap_request_count,
            available_listings, demand_score, demand_level
     FROM v_book_demand ORDER BY demand_score DESC, title LIMIT 20`
  );
  const courses = await query(
    `SELECT course_id, code, name, available_listings, demand_score, demand_level
     FROM v_course_demand ORDER BY demand_score DESC, code LIMIT 10`
  );
  return { books, courses };
});

export const dynamic = "force-dynamic";
