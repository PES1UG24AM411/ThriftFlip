import {
  beforeEach,
  describe,
  expect,
  it,
  afterAll,
} from "vitest";

import {
  pool,
  resetData,
  setupCampus,
  makeStudent,
  makeBook,
  makeListing,
  one,
} from "./helpers";

import { existsSync } from "node:fs";

import {
  BUNDLED_COVER_ISBNS,
  bundledCover,
  openLibraryCover,
  safeCoverUrl,
} from "../lib/covers";

let base: Awaited<ReturnType<typeof setupCampus>>;

beforeEach(async () => {
  await resetData();
  base = await setupCampus();
});

afterAll(async () => {
  await pool.end();
});

describe("cover links (lib/covers.ts)", () => {
  it("builds an Open Library link for ISBN-10 or ISBN-13", () => {
    expect(
      openLibraryCover("978-0-13-235088-4")
    ).toBe(
      "https://covers.openlibrary.org/b/isbn/9780132350884-L.jpg?default=false"
    );

    expect(openLibraryCover("0132350882")).toContain(
      "/0132350882-L.jpg"
    );

    expect(openLibraryCover("123")).toBeNull();
    expect(openLibraryCover(null)).toBeNull();
  });

  it("every bundled cover points to an existing file", () => {
    for (const isbn of BUNDLED_COVER_ISBNS) {
      const cover = bundledCover(isbn);

      expect(cover).not.toBeNull();
      expect(existsSync(`public${cover}`)).toBe(true);
    }

    expect(
      bundledCover("978-0-262-04630-5")
    ).toBe("/covers/9780262046305.jpg");

    expect(
      bundledCover("9780133071429")
    ).toBe("/covers/9780133071429.svg");

    expect(bundledCover("9780000000000")).toBeNull();
    expect(bundledCover(null)).toBeNull();
  });

  it("accepts safe local cover paths", () => {
    expect(
      safeCoverUrl("/covers/9780262046305.jpg")
    ).toBe("/covers/9780262046305.jpg");

    expect(
      safeCoverUrl("/covers/9780133071429.svg")
    ).toBe("/covers/9780133071429.svg");

    const badUrls = [
      "/covers/../secret.svg",
      "/other/x.svg",
      "//evil.com/x.png",
      "/covers/a/b.svg",
      "/covers/x.exe",
    ];

    for (const bad of badUrls) {
      expect(safeCoverUrl(bad)).toBeNull();
    }
  });

  it("accepts only plain HTTP/HTTPS links", () => {
    expect(
      safeCoverUrl(
        " https://covers.openlibrary.org/b/id/1-L.jpg "
      )
    ).toBe(
      "https://covers.openlibrary.org/b/id/1-L.jpg"
    );

    const badUrls = [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "ftp://x/y.jpg",
      "",
      "   ",
      null,
      undefined,
      5,
    ];

    for (const bad of badUrls) {
      expect(safeCoverUrl(bad)).toBeNull();
    }
  });
});

describe("book.cover_url reaches the listing queries", () => {
  it("v_listing_details exposes cover_url next to cover_image_id", async () => {
    const seller = await makeStudent(base);
    const book = await makeBook(base.course);

    await pool.query(
      `UPDATE book
       SET cover_url = 'https://covers.openlibrary.org/b/isbn/9780132350884-L.jpg'
       WHERE book_id = $1`,
      [book]
    );

    const withCover = await makeListing(
      seller,
      base.campus,
      book
    );

    const noCover = await makeListing(
      seller,
      base.campus,
      await makeBook(base.course)
    );

    const goods = await makeListing(
      seller,
      base.campus,
      null
    );

    const row = (id: number) =>
      one(
        `SELECT cover_url, cover_image_id
         FROM v_listing_details
         WHERE listing_id = $1`,
        [id]
      );

    expect(await row(withCover)).toEqual({
      cover_url:
        "https://covers.openlibrary.org/b/isbn/9780132350884-L.jpg",
      cover_image_id: null,
    });

    expect((await row(noCover)).cover_url).toBeNull();
    expect((await row(goods)).cover_url).toBeNull();
  });
});
