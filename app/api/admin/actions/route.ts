import { handle, HttpError, parseBody } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireAdmin } from "@/lib/auth/session";
import { adminActionSchema } from "@/lib/validation/schemas";

// One explicit moderation step with a required reason. The database function checks the rules and records it.
export const POST = handle(async (req) => {
  const admin = await requireAdmin();
  const b = await parseBody(req, adminActionSchema);
  const needs = b.action.endsWith("_USER") ? b.studentId : b.action.endsWith("_LISTING") ? b.listingId : b.reviewId;
  if (!needs) throw new HttpError(400, "Choose what the action is for");
  await query("SELECT admin_take_action($1::int, $2::text, $3::text, $4::int, $5::int, $6::int, $7::int)", [
    admin.id, b.action, b.reason, b.studentId ?? null, b.listingId ?? null, b.reviewId ?? null, b.reportId ?? null,
  ]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
