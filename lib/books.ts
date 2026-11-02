// Finds a book in the catalogue or creates it. Used when a seller lists a book and when a student adds a
// book to the wanted list, so both end up pointing at the SAME book row (that is what makes matching work).
import type { PoolClient } from "pg";
import { HttpError } from "./errors";
import { openLibraryCover } from "./covers";

export interface BookInput {
  title: string;
  author?: string; // a textbook listing always has one (checked by the Zod schema); a wanted book may not
  edition: number;
  isbn?: string;
  courseId?: number | null;
}

export async function findOrCreateBook(c: PoolClient, b: BookInput): Promise<number> {
  const author = b.author?.trim() || "Unknown author";
  // 1. same ISBN = same book
  if (b.isbn) {
    const byIsbn = await c.query("SELECT book_id FROM book WHERE isbn = $1", [b.isbn]);
    if (byIsbn.rows[0]) {
      await c.query("UPDATE book SET cover_url = COALESCE(cover_url, $2) WHERE book_id = $1", [byIsbn.rows[0].book_id, openLibraryCover(b.isbn)]);
      return byIsbn.rows[0].book_id as number;
    }
  }

  // 2. same title + edition + compatible author = same book (even if one of the two entries has an ISBN and the other has not).
  //    "Same" is defined once in the database (norm_text / authors_compatible, migration 019), the same rule price alerts use:
  //    capital letters and punctuation do not matter, and "Kurose" matches "James Kurose, Keith Ross".
  //    Without this a slightly different spelling created a second catalogue row and alerts on the first row never matched.
  const same = await c.query(
    `SELECT book_id, isbn FROM book
     WHERE norm_text(title) = norm_text($1) AND edition = $3 AND authors_compatible(author, $2)
     ORDER BY (isbn IS NOT NULL) DESC, book_id LIMIT 1`,
    [b.title, author, b.edition]
  );
  if (same.rows[0]) {
    const found = same.rows[0];
    // the new entry knows the ISBN but the catalogue row does not: complete the row
    if (b.isbn && !found.isbn) {
      await c.query("UPDATE book SET isbn = $1, cover_url = COALESCE(cover_url, $2) WHERE book_id = $3", [b.isbn, openLibraryCover(b.isbn), found.book_id]);
    }
    return found.book_id as number;
  }

  // 3. a new book
  const course = b.courseId ? (await c.query("SELECT name FROM course WHERE course_id = $1", [b.courseId])).rows[0] : null;
  if (b.courseId && !course) throw new HttpError(400, "Unknown course");
  const created = await c.query(
    `INSERT INTO book (isbn, title, author, edition, subject, course_id, cover_url) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (isbn) DO UPDATE SET isbn = EXCLUDED.isbn RETURNING book_id`,
    // only a link to Open Library is stored (nothing is downloaded); the page falls back if it does not load
    [b.isbn ?? null, b.title, author, b.edition, course?.name ?? "General", b.courseId ?? null, b.isbn ? openLibraryCover(b.isbn) : null]
  );
  return created.rows[0].book_id as number;
}
