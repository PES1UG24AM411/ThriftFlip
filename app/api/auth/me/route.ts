import { handle } from "@/lib/http";
import { queryOne } from "@/lib/db/pool";
import { getSession } from "@/lib/auth/session";

export const GET = handle(async () => {
  const session = await getSession();
  if (!session) return { user: null };
  if (session.role === "ADMIN") {
    const admin = await queryOne("SELECT admin_id AS id, name, email FROM admin WHERE admin_id = $1", [session.id]);
    return { user: admin ? { ...admin, role: "ADMIN" } : null };
  }
  const student = await queryOne(
    `SELECT s.student_id AS id, s.name, s.email, s.srn, s.semester, s.program, s.status,
            d.name AS department, c.name AS campus
     FROM student s JOIN department d ON d.department_id = s.department_id JOIN campus c ON c.campus_id = s.campus_id
     WHERE s.student_id = $1`,
    [session.id]
  );
  return { user: student ? { ...student, role: "STUDENT" } : null };
});

export const dynamic = "force-dynamic";
