// Dropdown data (read from the database): campuses, departments of a campus, department names, courses.
import { handle, HttpError, parseId, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";

export const GET = handle(async (req) => {
  const sp = searchParams(req);
  const type = sp.get("type");
  if (type === "campuses") return query("SELECT campus_id AS id, name FROM campus ORDER BY name");
  if (type === "departments") {
    // registration: first the campus, then that campus's departments
    return query("SELECT department_id AS id, name FROM department WHERE campus_id = $1 ORDER BY name", [parseId(sp.get("campusId"), "campusId")]);
  }
  if (type === "department-names") return query("SELECT DISTINCT name FROM department ORDER BY name"); // search filter
  if (type === "courses") {
    const dept = sp.get("departmentId");
    return query(
      `SELECT c.course_id AS id, c.code, c.name, c.semester, d.name AS department
       FROM course c JOIN department d ON d.department_id = c.department_id
       WHERE ($1::int IS NULL OR c.department_id = $1::int)
       ORDER BY d.name, c.semester, c.code`,
      [dept ? parseId(dept, "departmentId") : null]
    );
  }
  throw new HttpError(400, "type must be campuses, departments, department-names or courses");
});

export const dynamic = "force-dynamic";
