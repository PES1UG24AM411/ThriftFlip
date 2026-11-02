import { handle, HttpError, parseBody } from "@/lib/http";
import { query, queryOne } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { profileUpdateSchema } from "@/lib/validation/schemas";

export const GET = handle(async () => {
  const user = await requireStudent();
  const me = await queryOne(
    `SELECT s.student_id AS id, s.name, s.email, s.srn, s.semester, s.program, s.warning_count, s.created_at,
            s.department_id, d.name AS department, s.campus_id, c.name AS campus, s.contact_preference, s.phone, s.show_contact,
            (SELECT image_id FROM image WHERE owner_id = s.student_id AND purpose = 'PROFILE') AS profile_image_id
     FROM student s JOIN department d ON d.department_id = s.department_id JOIN campus c ON c.campus_id = s.campus_id
     WHERE s.student_id = $1`,
    [user.id]
  );
  const ratingSummary = await queryOne("SELECT * FROM v_student_ratings WHERE student_id = $1", [user.id]);
  const stats = await queryOne(
    `SELECT (SELECT COUNT(*)::int FROM listing WHERE seller_id = $1 AND status = 'ACTIVE') AS active_listings,
            (SELECT COUNT(*)::int FROM transactions WHERE (buyer_id = $1 OR seller_id = $1) AND state NOT IN ('RELEASED','CANCELLED')) AS open_transactions,
            (SELECT COUNT(*)::int FROM wishlist WHERE student_id = $1) AS wishlist,
            (SELECT COUNT(*)::int FROM notification WHERE student_id = $1 AND NOT is_read) AS unread_notifications`,
    [user.id]
  );
  const myListings = await query(
    "SELECT listing_id, title, price, status, listing_type FROM listing WHERE seller_id = $1 AND status <> 'REMOVED' ORDER BY created_at DESC LIMIT 20",
    [user.id]
  );
  return { me, ratingSummary, stats, myListings };
});

// Update semester, department, contact preferences. The database trigger enforces the rules:
// the semester cannot go backwards and the department can only change in semesters 1 and 2.
export const PUT = handle(async (req) => {
  const user = await requireStudent();
  const body = await parseBody(req, profileUpdateSchema);
  const columns: Record<string, string> = {
    semester: "semester", departmentId: "department_id", contactPreference: "contact_preference",
    phone: "phone", showContact: "show_contact",
  };
  const sets: string[] = [];
  const params: unknown[] = [user.id];
  for (const [key, column] of Object.entries(columns)) {
    const value = (body as Record<string, unknown>)[key];
    if (value !== undefined) {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length === 0) throw new HttpError(400, "Nothing to update");
  await query(`UPDATE student SET ${sets.join(", ")} WHERE student_id = $1`, params);
  return { ok: true };
});

export const dynamic = "force-dynamic";
