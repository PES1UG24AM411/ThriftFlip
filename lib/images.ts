// Validates an uploaded image: size limit and file type checked from the file's first bytes
// (the browser-supplied type is not trusted). Images are stored in PostgreSQL (table image).
import { HttpError } from "./errors";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// A validated image, ready to be stored in the image table.
export interface UploadedImage {
  data: Buffer;
  contentType: string;
}

export async function readImage(file: File): Promise<UploadedImage> {
  if (file.size === 0) throw new HttpError(400, "The image is empty");
  if (file.size > MAX_IMAGE_BYTES) throw new HttpError(400, "Each image must be 2 MB or smaller");
  const data = Buffer.from(await file.arrayBuffer());
  const b = data;
  let contentType: string | null = null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) contentType = "image/jpeg";
  else if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) contentType = "image/png";
  else if (b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") contentType = "image/webp";
  if (!contentType) throw new HttpError(400, "Only JPEG, PNG and WebP images are allowed");
  return { data, contentType };
}
