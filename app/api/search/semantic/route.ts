// Semantic search: query text -> 384-d embedding (all-MiniLM-L6-v2) -> pgvector cosine similarity.
import { handle, HttpError, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { LISTING_CARD_COLUMNS } from "@/lib/sql";
import { embedText, toVectorLiteral } from "@/lib/embeddings/embed";

export const GET = handle(async (req) => {
  const user = await requireStudent();
  const sp = searchParams(req);
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  if (!q) throw new HttpError(400, "Enter something to search for");
  const campusId = sp.get("campusId") ? Number(sp.get("campusId")) : null;

  const vector = toVectorLiteral(await embedText(q));
  const rows = await query(
    `SELECT ${LISTING_CARD_COLUMNS}, s.similarity
     FROM semantic_search($1::vector, 20, $2::int) s
     JOIN v_listing_details d ON d.listing_id = s.listing_id
     ORDER BY s.similarity DESC`,
    [vector, campusId]
  );
  await query(
    `INSERT INTO search_activity (student_id, query_text, search_type, book_id, course_id) VALUES ($1, $2, 'SEMANTIC', $3, $4)`,
    [user.id, q, rows[0]?.book_id ?? null, rows[0]?.course_id ?? null]
  );
  return { items: rows };
});

export const dynamic = "force-dynamic";
