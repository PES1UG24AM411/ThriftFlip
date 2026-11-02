// Full-text search: tsvector + GIN index, ranked with ts_rank.
import { handle, HttpError, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { LISTING_CARD_COLUMNS } from "@/lib/sql";
import { buildListingQuery } from "@/lib/listingFilters";

export const GET = handle(async (req) => {
  const user = await requireStudent();
  const q = (searchParams(req).get("q") ?? "").trim().slice(0, 200);
  if (!q) throw new HttpError(400, "Enter something to search for");

  // same matching as the marketplace: partial words work, the full-text index adds related word forms
  const f = buildListingQuery(new URLSearchParams({ q, pageSize: "30" }), user.id);
  const rows = await query(
    `SELECT ${LISTING_CARD_COLUMNS}
     FROM v_listing_details d
     JOIN listing l ON l.listing_id = d.listing_id
     WHERE ${f.where.join(" AND ")}
     ORDER BY ${f.orderBy}
     LIMIT 30`,
    f.params
  );
  await query(
    `INSERT INTO search_activity (student_id, query_text, search_type, book_id, course_id) VALUES ($1, $2, 'FULLTEXT', $3, $4)`,
    [user.id, q, rows[0]?.book_id ?? null, rows[0]?.course_id ?? null]
  );
  return { items: rows };
});

export const dynamic = "force-dynamic";
