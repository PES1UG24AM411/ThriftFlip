import { handle, HttpError, parseId } from "@/lib/http";
import { query, queryOne } from "@/lib/db/pool";
import { requireUser } from "@/lib/auth/session";

// Public profile page of a student (no e-mail, no student ID).
export const GET = handle(async (_req, ctx) => {
  await requireUser();
  const id = parseId(ctx.params.id);
  const student = await queryOne(
    `SELECT s.student_id AS id, s.name, d.name AS department, c.name AS campus, s.semester, s.created_at,
            (SELECT image_id FROM image WHERE owner_id = s.student_id AND purpose = 'PROFILE') AS profile_image_id
     FROM student s JOIN department d ON d.department_id = s.department_id JOIN campus c ON c.campus_id = s.campus_id
     WHERE s.student_id = $1`,
    [id]
  );
  if (!student) throw new HttpError(404, "Student not found");
  const ratingSummary = await queryOne("SELECT * FROM v_student_ratings WHERE student_id = $1", [id]);
  const ratings = await query(
    `SELECT r.score, r.created_at, CASE WHEN rv.is_hidden THEN NULL ELSE rv.body END AS review, s.name AS rater_name
     FROM rating r JOIN student s ON s.student_id = r.rater_id LEFT JOIN review rv ON rv.rating_id = r.rating_id
     WHERE r.ratee_id = $1 ORDER BY r.created_at DESC LIMIT 20`,
    [id]
  );
  const listings = await query(
    "SELECT listing_id, title, price, listing_type FROM listing WHERE seller_id = $1 AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 10",
    [id]
  );
  return { student, ratingSummary, ratings, listings };
});

export const dynamic = "force-dynamic";
