import { NextResponse } from "next/server";
import { handle, HttpError } from "@/lib/http";
import { query, withTransaction } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { readImage } from "@/lib/images";

// One profile photo per student (partial unique index): uploading replaces the old one.
export const POST = handle(async (req) => {
  const user = await requireStudent();
  const file = (await req.formData()).get("file");
  if (!file || typeof file === "string") throw new HttpError(400, "Choose an image");
  const img = await readImage(file);
  const id = await withTransaction(async (c) => {
    await c.query("DELETE FROM image WHERE owner_id = $1 AND purpose = 'PROFILE'", [user.id]);
    const r = await c.query(
      `INSERT INTO image (owner_id, purpose, content_type, size_bytes, data) VALUES ($1, 'PROFILE', $2, $3, $4) RETURNING image_id`,
      [user.id, img.contentType, img.data.length, img.data]
    );
    return r.rows[0].image_id as number;
  });
  return NextResponse.json({ imageId: id }, { status: 201 });
});

export const DELETE = handle(async () => {
  const user = await requireStudent();
  await query("DELETE FROM image WHERE owner_id = $1 AND purpose = 'PROFILE'", [user.id]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
