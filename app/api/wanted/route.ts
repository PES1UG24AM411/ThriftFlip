import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, parseBody, parseId, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";

const wantedSchema = z.object({
  bookId: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  author: z.string().trim().max(300).optional(),
}).refine(
  (data) => Boolean(data.bookId || data.title),
  { message: "Select a book or enter a book title." }
);

export const GET = handle(async () => {
  const user = await requireStudent();

  return query(
    `SELECT
       w.wanted_book_id,
       b.book_id,
       b.title,
       b.author,
       b.edition,
       COUNT(l.listing_id)::int AS swappable_copies
     FROM student_wanted_book w
     JOIN book b ON b.book_id = w.book_id
     LEFT JOIN listing l
       ON l.book_id = b.book_id
       AND l.status = 'ACTIVE'
       AND l.open_to_swap = TRUE
       AND l.listing_type = 'FIXED_PRICE'
       AND l.seller_id <> w.student_id
     WHERE w.student_id = $1
     GROUP BY w.wanted_book_id, b.book_id, b.title, b.author, b.edition
     ORDER BY w.created_at DESC`,
    [user.id]
  );
});

export const POST = handle(async (req) => {
  const user = await requireStudent();
  const body = await parseBody(req, wantedSchema);

  let bookId = body.bookId;

  if (!bookId && body.title) {
    const title = body.title.trim();
    const author = body.author?.trim() || "Unknown";

    const existing = await query(
      `SELECT book_id
       FROM book
       WHERE lower(trim(title)) = lower($1)
         AND lower(trim(author)) = lower($2)
       ORDER BY book_id
       LIMIT 1`,
      [title, author]
    );

    if (existing.length > 0) {
      bookId = existing[0].book_id;
    } else {
      const created = await query(
        `INSERT INTO book (title, author, subject)
         VALUES ($1, $2, 'General')
         RETURNING book_id`,
        [title, author]
      );
      bookId = created[0].book_id;
    }
  }

  await query(
    `INSERT INTO student_wanted_book (student_id, book_id)
     VALUES ($1, $2)
     ON CONFLICT (student_id, book_id) DO NOTHING`,
    [user.id, bookId]
  );

  return NextResponse.json({ ok: true }, { status: 201 });
});

export const DELETE = handle(async (req) => {
  const user = await requireStudent();
  const id = parseId(searchParams(req).get("id"), "id");

  await query(
    `DELETE FROM student_wanted_book
     WHERE wanted_book_id = $1 AND student_id = $2`,
    [id, user.id]
  );

  return { ok: true };
});

export const dynamic = "force-dynamic";
