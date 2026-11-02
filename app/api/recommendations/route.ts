// Recommendations = recommend_listings() in the database (migration 012). Rule-based ranking, in this order of strength:
//   1. course / department / semester match          2. same book or subject as the favorites, recent searches and views
//   3. vector similarity to the favorites (only when embeddings exist)   4. same campus   5. recently listed textbooks
// Every available listing of another student is a candidate, so the page is never empty while the marketplace has books.
// Own, favorited and unavailable (reserved / sold / swapped / removed) listings are excluded inside the function.
import { handle } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { LISTING_CARD_COLUMNS } from "@/lib/sql";

export const GET = handle(async () => {
  const user = await requireStudent();
  return query(
    `SELECT ${LISTING_CARD_COLUMNS}, r.score, r.reason
     FROM recommend_listings($1::int, 12) r
     JOIN v_listing_details d ON d.listing_id = r.listing_id
     ORDER BY r.score DESC, d.created_at DESC, d.listing_id DESC`,
    [user.id]
  );
});

export const dynamic = "force-dynamic";
