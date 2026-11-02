import { handle, HttpError, parseId } from "@/lib/http";
import { queryOne } from "@/lib/db/pool";
import { requireUser } from "@/lib/auth/session";

// Serves a stored image (book photos and profile photos). Logged-in users only.
export const GET = handle(async (_req, ctx) => {
  await requireUser();
  const img = await queryOne<{ content_type: string; data: Buffer }>(
    "SELECT content_type, data FROM image WHERE image_id = $1", [parseId(ctx.params.id)]);
  if (!img) throw new HttpError(404, "Image not found");
  return new Response(new Uint8Array(img.data), {
    headers: { "Content-Type": img.content_type, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
  });
});

export const dynamic = "force-dynamic";
