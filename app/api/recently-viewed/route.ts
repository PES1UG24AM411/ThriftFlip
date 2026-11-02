import { handle } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { LISTING_CARD_COLUMNS } from "@/lib/sql";

export const GET = handle(async () => {
  const user = await requireStudent();
  return query(
    `SELECT ${LISTING_CARD_COLUMNS}, rv.viewed_at
     FROM recently_viewed rv JOIN v_listing_details d ON d.listing_id = rv.listing_id
     WHERE rv.student_id = $1 AND d.status <> 'REMOVED'
     ORDER BY rv.viewed_at DESC LIMIT 20`,
    [user.id]
  );
});

export const dynamic = "force-dynamic";
