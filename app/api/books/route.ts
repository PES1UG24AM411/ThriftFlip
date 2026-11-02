import { handle } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { searchParams } from "@/lib/http";

export const GET = handle(async (req) => {
  await requireStudent();
  const q = (searchParams(req).get("q") ?? "").trim().slice(0, 100);
  return query(
    `SELECT book_id AS id, title, author, edition, subject, course_id
     FROM book
     WHERE $1 = '' OR title ILIKE '%' || $1 || '%' OR author ILIKE '%' || $1 || '%' OR subject ILIKE '%' || $1 || '%'
     ORDER BY title LIMIT 30`,
    [q]
  );
});

export const dynamic = "force-dynamic";
