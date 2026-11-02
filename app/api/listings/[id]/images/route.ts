import { NextResponse } from "next/server";
import { handle, HttpError, parseId, searchParams } from "@/lib/http";
import { query, queryOne, withTransaction } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { readImage, type UploadedImage } from "@/lib/images";

// Upload book photos (multipart form, field "files", max 5 per listing, 2 MB each, JPEG/PNG/WebP).
export const POST = handle(async (req, ctx) => {
  const user = await requireStudent();
  const listingId = parseId(ctx.params.id);
  const owner = await queryOne("SELECT 1 FROM listing WHERE listing_id = $1 AND seller_id = $2", [listingId, user.id]);
  if (!owner) throw new HttpError(404, "Listing not found or not yours");

  const files = (await req.formData()).getAll("files").filter((f): f is File => typeof f !== "string");
  if (files.length === 0) throw new HttpError(400, "Choose at least one image");
  if (files.length > 1) throw new HttpError(400, "At most 1 image per upload");
  const images: UploadedImage[] = []; // explicit type: an untyped `[]` that is pushed to and then used inside a closure becomes implicit any[]
  for (const f of files) images.push(await readImage(f));

  await withTransaction(async (c) => {
    for (const img of images) {
      const pos = (await c.query("SELECT COUNT(*)::int AS n FROM listing_image WHERE listing_id = $1", [listingId])).rows[0].n;
      const row = await c.query(
        `INSERT INTO image (owner_id, purpose, content_type, size_bytes, data) VALUES ($1, 'LISTING', $2, $3, $4) RETURNING image_id`,
        [user.id, img.contentType, img.data.length, img.data]
      );
      // trigger trg_listing_image_rules enforces "max 5 photos per listing"
      await c.query("INSERT INTO listing_image (listing_id, image_id, position) VALUES ($1, $2, $3)", [listingId, row.rows[0].image_id, pos]);
    }
  });
  return NextResponse.json({ ok: true, uploaded: images.length }, { status: 201 });
});

export const DELETE = handle(async (req, ctx) => {
  const user = await requireStudent();
  const listingId = parseId(ctx.params.id);
  const imageId = parseId(searchParams(req).get("imageId"), "imageId");
  const rows = await query(
    `DELETE FROM image WHERE image_id = $1 AND owner_id = $2 AND purpose = 'LISTING'
       AND image_id IN (SELECT image_id FROM listing_image WHERE listing_id = $3) RETURNING image_id`,
    [imageId, user.id, listingId]
  );
  if (rows.length === 0) throw new HttpError(404, "Photo not found");
  return { ok: true };
});

export const dynamic = "force-dynamic";
