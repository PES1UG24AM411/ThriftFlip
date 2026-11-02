import { NextResponse } from "next/server";
import { handle, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { reportSchema } from "@/lib/validation/schemas";

export const POST = handle(async (req) => {
  const user = await requireStudent();
  const b = await parseBody(req, reportSchema);
  const rows = await query(
    `INSERT INTO report (reporter_id, reported_listing_id, reported_student_id, reason, details)
     VALUES ($1, $2, $3, $4, $5) RETURNING report_id`,
    [user.id, b.listingId ?? null, b.studentId ?? null, b.reason, b.details ?? null]
  );
  return NextResponse.json({ id: rows[0].report_id }, { status: 201 });
});

export const dynamic = "force-dynamic";
