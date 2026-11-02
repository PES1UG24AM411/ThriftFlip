// lib/covers.ts

export const BUNDLED_COVER_ISBNS: readonly string[] = [
  "9780078022159",
  "9780133071429",
  "9780133970777",
  "9780134610993",
  "9780136681557",
  "9780262035613",
  "9780262046305",
  "9780387310732",
  "9780470458365",
  "9780980232776",
  "9781098125974",
  "9781119800361",
];

const SVG_ONLY_ISBNS: readonly string[] = [
  "9780133071429",
  "9780136681557",
  "9781119800361",
];

export const normalizeISBN = (
  isbn: string | null | undefined
): string => {
  return (isbn ?? "").replace(/[^0-9Xx]/g, "");
};

export const bundledCover = (
  isbn: string | null | undefined
): string | null => {
  const clean = normalizeISBN(isbn);

  if (!BUNDLED_COVER_ISBNS.includes(clean)) {
    return null;
  }

  if (SVG_ONLY_ISBNS.includes(clean)) {
    return `/covers/${clean}.svg`;
  }

  return `/covers/${clean}.jpg`;
};

export const safeCoverUrl = (
  url: unknown
): string | null => {
  if (typeof url !== "string") {
    return null;
  }

  const value = url.trim();

  if (!value || value.length > 2000) {
    return null;
  }

  if (
    /^\/covers\/[A-Za-z0-9_-]+\.(svg|png|jpe?g|webp)$/i.test(
      value
    )
  ) {
    return value;
  }

  if (/^https?:\/\/[^\s]+$/i.test(value)) {
    return value;
  }

  return null;
};

export const openLibraryCover = (
  isbn: string | null | undefined
): string | null => {
  const clean = normalizeISBN(isbn);

  if (clean.length !== 10 && clean.length !== 13) {
    return null;
  }

  return `https://covers.openlibrary.org/b/isbn/${clean}-L.jpg?default=false`;
};
