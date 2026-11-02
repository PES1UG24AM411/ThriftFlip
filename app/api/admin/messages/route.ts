import { NextResponse } from "next/server";
import { handle, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";
import { adminMessageSchema } from "@/lib/validation/schemas";

// Official message (or request for clarification) to a student. They are notified and can answer.
export const POST = handle(async (req) => {
  const admin = await requireAdmin();
  const b = await parseBody(req, adminMessageSchema);
  const rows = await query("SELECT admin_send_message($1::int, $2::int, $3::text, $4::text, $5::int, $6::int) AS id", [
    admin.id, b.studentId, b.body, b.kind, b.reportId ?? null, b.listingId ?? null,
  ]);
  return NextResponse.json({ id: rows[0].id }, { status: 201 });
});

export const dynamic = "force-dynamic";
