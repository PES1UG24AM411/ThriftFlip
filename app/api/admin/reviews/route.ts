import { handle } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";

export const GET = handle(async () => {
  await requireAdmin();
  return query(
    `SELECT rv.review_id, rv.body, rv.is_hidden, rv.hidden_reason, rv.created_at, r.score,
            rater.name AS rater_name, ratee.name AS ratee_name
     FROM review rv JOIN rating r ON r.rating_id = rv.rating_id
     JOIN student rater ON rater.student_id = r.rater_id JOIN student ratee ON ratee.student_id = r.ratee_id
     ORDER BY rv.is_hidden, rv.created_at DESC LIMIT 100`
  );
});

export const dynamic = "force-dynamic";
