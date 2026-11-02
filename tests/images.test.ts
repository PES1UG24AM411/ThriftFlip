import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, readImage, type UploadedImage } from "../lib/images";
import { HttpError } from "../lib/errors";

// real file signatures (magic bytes): the type is detected from them, never from the browser-supplied type
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from("VP8 ")]);

describe("readImage (used by the listing image upload route)", () => {
  it("returns typed images for several files, as the route collects them", async () => {
    const files = [new File([png], "a.png"), new File([jpg], "b.jpg"), new File([webp], "c.webp")];
    const images: UploadedImage[] = []; // same shape as in app/api/listings/[id]/images/route.ts
    for (const f of files) images.push(await readImage(f));
    expect(images.map((i) => i.contentType)).toEqual(["image/png", "image/jpeg", "image/webp"]);
    expect(images[0].data.equals(png)).toBe(true); // bytes are stored unchanged
  });

  it("ignores a lying content type and rejects non-images", async () => {
    expect((await readImage(new File([png], "x.txt", { type: "text/plain" }))).contentType).toBe("image/png");
    await expect(readImage(new File([Buffer.from("<html></html>")], "x.png", { type: "image/png" }))).rejects.toThrow(/Only JPEG, PNG and WebP/);
  });

  it("rejects empty and oversized files with a 400", async () => {
    const empty = await readImage(new File([], "e.png")).catch((e) => e);
    expect(empty).toBeInstanceOf(HttpError);
    expect(empty.status).toBe(400);
    await expect(readImage(new File([Buffer.alloc(MAX_IMAGE_BYTES + 1)], "big.jpg"))).rejects.toThrow(/2 MB/);
  });
});
