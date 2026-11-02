// Builds the text that is embedded for one listing. The same function is used by the batch
// script (npm run embeddings:generate) and by the API when a listing is created or edited,
// so stored vectors always describe the same fields.

import type { Pool, PoolClient, Client } from "pg";

type Queryable = Pool | PoolClient | Client;

const CONDITION_WORDS: Record<string, string> = {
  NEW: "brand new",
  LIKE_NEW: "like new",
  GOOD: "good condition",
  FAIR: "fair condition, some wear",
  POOR: "poor condition, heavily used",
};

export interface ListingTextRow {
  listing_id: number;
  title: string;
  description: string;
  category: string;
  item_condition: string;
  author: string | null;
  subject: string | null;
  edition: number | null;
  course_code: string | null;
  course_name: string | null;
}

export function buildListingText(r: ListingTextRow): string {
  const parts: string[] = [r.title];
  if (r.author) parts.push(`by ${r.author}`);
  if (r.subject) parts.push(`subject: ${r.subject}`);
  if (r.course_name) parts.push(`course: ${r.course_code ?? ""} ${r.course_name}`.trim());
  if (r.edition) parts.push(`edition ${r.edition}`);
  parts.push(CONDITION_WORDS[r.item_condition] ?? r.item_condition);
  if (r.description) parts.push(r.description);
  return parts.join(". ");
}

const SELECT_LISTING_TEXT_ROWS = `
  SELECT l.listing_id, l.title, l.description, l.category, l.item_condition,
         b.author, b.subject, b.edition, c.code AS course_code, c.name AS course_name
  FROM listing l
  LEFT JOIN book b ON b.book_id = l.book_id
  LEFT JOIN course c ON c.course_id = b.course_id
`;

export async function loadListingTextRows(db: Queryable, listingId?: number): Promise<ListingTextRow[]> {
  if (listingId !== undefined) {
    const res = await db.query(`${SELECT_LISTING_TEXT_ROWS} WHERE l.listing_id = $1`, [listingId]);
    return res.rows as ListingTextRow[];
  }
  const res = await db.query(`${SELECT_LISTING_TEXT_ROWS} WHERE l.status <> 'REMOVED' ORDER BY l.listing_id`);
  return res.rows as ListingTextRow[];
}
