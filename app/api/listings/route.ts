import { NextResponse } from "next/server";
import { handle, HttpError, parseBody, searchParams } from "@/lib/http";
import { query, withTransaction } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { listingCreateSchema } from "@/lib/validation/schemas";
import { LISTING_CARD_COLUMNS } from "@/lib/sql";
import { buildListingQuery } from "@/lib/listingFilters";
import { openLibraryCover } from "@/lib/covers";
import { upsertListingEmbedding } from "@/lib/embeddings/store";
import { saveWantedBooks } from "@/lib/wanted";

// Browse / filter / sort / paginate. The filters are built in lib/listingFilters.ts; everything runs in SQL.
// Partial words work ("alg" finds "Algorithms") and the PostgreSQL full-text index still helps with related words.
export const GET = handle(async (req) => {
  const user = await requireStudent();
  const f = buildListingQuery(searchParams(req), user.id);
  const params = [...f.params, f.pageSize, (f.page - 1) * f.pageSize];

  const rows = await query(
    `SELECT ${LISTING_CARD_COLUMNS}, (d.seller_id = $${f.params.length + 3}) AS is_mine, COUNT(*) OVER() AS total
     FROM v_listing_details d
     JOIN listing l ON l.listing_id = d.listing_id
     WHERE ${f.where.join(" AND ")}
     ORDER BY ${f.orderBy}
     LIMIT $${f.params.length + 1} OFFSET $${f.params.length + 2}`,
    [...params, user.id]
  );
  return { items: rows, total: rows.length ? Number(rows[0].total) : 0, page: f.page, pageSize: f.pageSize };
});

// Finds the book in the catalogue (same ISBN, or same title + author + edition) or creates it.
async function findOrCreateBook(
  c: import("pg").PoolClient,
  b: { title: string; author?: string; edition: number; isbn?: string; courseId?: number | null }
): Promise<number> {
  const course = b.courseId
    ? (await c.query("SELECT name FROM course WHERE course_id = $1", [b.courseId])).rows[0]
    : null;
  if (b.courseId && !course) throw new HttpError(400, "Unknown course");
  const subject = course?.name ?? "General";

  if (b.isbn) {
    // migration 015 adds book.cover_url; if it has not been applied yet, save the book without it instead of failing
    const hasCover = (await c.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'book' AND column_name = 'cover_url'")).rowCount! > 0;
    const res = hasCover
      ? await c.query(
          `INSERT INTO book (isbn, title, author, edition, subject, course_id, cover_url) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (isbn) DO UPDATE SET cover_url = COALESCE(book.cover_url, EXCLUDED.cover_url) RETURNING book_id`,
          // only a link to Open Library is stored (nothing is downloaded); the page falls back if it does not load
          [b.isbn, b.title, b.author, b.edition, subject, b.courseId ?? null, openLibraryCover(b.isbn)])
      : await c.query(
          `INSERT INTO book (isbn, title, author, edition, subject, course_id) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (isbn) DO UPDATE SET isbn = EXCLUDED.isbn RETURNING book_id`,
          [b.isbn, b.title, b.author, b.edition, subject, b.courseId ?? null]);
    return res.rows[0].book_id as number;
  }
  const existing = await c.query(
    "SELECT book_id FROM book WHERE lower(title) = lower($1) AND lower(author) = lower($2) AND edition = $3 AND isbn IS NULL LIMIT 1",
    [b.title, b.author, b.edition]
  );
  if (existing.rows[0]) return existing.rows[0].book_id as number;
  const res = await c.query(
    "INSERT INTO book (title, author, edition, subject, course_id) VALUES ($1, $2, $3, $4, $5) RETURNING book_id",
    [b.title, b.author, b.edition, subject, b.courseId ?? null]
  );
  return res.rows[0].book_id as number;
}

export const POST = handle(async (req) => {
  const user = await requireStudent();
  const b = await parseBody(req, listingCreateSchema);

  const listingId = await withTransaction(async (c) => {
    const campus = (await c.query("SELECT campus_id FROM student WHERE student_id = $1", [user.id])).rows[0].campus_id;
    let bookId: number | null = null;
    if (b.category === "TEXTBOOK") {
      bookId = b.bookId ?? (await findOrCreateBook(c, { title: b.title, author: b.author, edition: b.edition, isbn: b.isbn, courseId: b.courseId }));
    }
    const res = await c.query(
      `INSERT INTO listing (seller_id, book_id, campus_id, category, title, description, item_condition,
                            listing_type, price, open_to_swap)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING listing_id`,
      [user.id, bookId, campus, b.category, b.title, b.description, b.condition, b.listingType, b.price, b.openToSwap]
    );
    const id = res.rows[0].listing_id as number;
    if (b.listingType === "AUCTION") {
      await c.query(
        `INSERT INTO auction (listing_id, starting_price, min_increment, start_time, end_time)
         VALUES ($1, $2, $3, now(), now() + make_interval(hours => $4::int))`,
        [id, b.price, b.minIncrement, b.durationHours]
      );
    }
    await saveWantedBooks(c, id, b.openToSwap, b.wantedBooks ?? []);
    return id;
  });

  // Embedding is best effort: the listing exists even if the model cannot be loaded right now.
  // `npm run embeddings:generate` fills in anything that is missing.
  upsertListingEmbedding(listingId).catch((e) => console.error("embedding failed", e));
  return NextResponse.json({ id: listingId }, { status: 201 });
});

export const dynamic = "force-dynamic";
