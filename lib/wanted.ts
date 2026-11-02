import type { PoolClient } from "pg";

export type WantedInput = Array<{ bookId: number } | { title: string }>;

// Replaces the wanted books of a listing. A listing that is not open to swap has none.
// Duplicates are ignored (unique indexes) and the limit of 5 is enforced by a trigger in the database.
// Catalogue books are also saved as swap preferences, which is what swap matching (find_swap_cycles) reads, so a
// book wanted here is found by direct and circular swap matching and shows up under "What I want in return".
export async function saveWantedBooks(c: PoolClient, listingId: number, openToSwap: boolean, wanted: WantedInput) {
  await c.query("DELETE FROM listing_wanted_book WHERE listing_id = $1", [listingId]);
  if (!openToSwap) return; // swap preferences are kept, they simply do nothing while the listing is not open to swaps
  // A typed title that already exists in the catalogue (same words, capital letters and punctuation ignored) is stored as that
  // catalogue book, so swap matching uses a book id and not just text. Titles nobody has listed stay typed titles; the
  // database still compares them with the titles of open listings.
  const typed: Array<{ title: string; bookId: number | null }> = [];
  for (const w of wanted) {
    if ("bookId" in w) continue;
    const hit = await c.query(
      "SELECT book_id FROM book WHERE norm_text(title) = norm_text($1) ORDER BY (isbn IS NOT NULL) DESC, book_id LIMIT 1", [w.title]);
    typed.push({ title: w.title, bookId: hit.rows[0]?.book_id ?? null });
  }
  const ids = [...wanted.flatMap((w) => ("bookId" in w ? [w.bookId] : [])), ...typed.flatMap((t) => (t.bookId ? [t.bookId] : []))];
  // preferences of this listing that the seller removed from the list
  await c.query("DELETE FROM swap_preference WHERE offered_listing_id = $1 AND NOT (wanted_book_id = ANY($2::int[]))", [listingId, ids]);
  const addPreference = (bookId: number) =>
    c.query(
      `INSERT INTO swap_preference (student_id, offered_listing_id, wanted_book_id)
       SELECT seller_id, listing_id, $2 FROM listing WHERE listing_id = $1 AND EXISTS (SELECT 1 FROM book WHERE book_id = $2)
       ON CONFLICT (offered_listing_id, wanted_book_id) DO NOTHING`, [listingId, bookId]);
  for (const w of wanted) {
    if ("bookId" in w) {
      await c.query("INSERT INTO listing_wanted_book (listing_id, book_id) SELECT $1, book_id FROM book WHERE book_id = $2 ON CONFLICT DO NOTHING", [listingId, w.bookId]);
      await addPreference(w.bookId);
    } else {
      const t = typed.find((x) => x.title === w.title)!;
      if (t.bookId) {
        await c.query("INSERT INTO listing_wanted_book (listing_id, book_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [listingId, t.bookId]);
        await addPreference(t.bookId);
      } else {
        await c.query("INSERT INTO listing_wanted_book (listing_id, custom_title) VALUES ($1, $2) ON CONFLICT DO NOTHING", [listingId, w.title]);
      }
    }
  }
}
