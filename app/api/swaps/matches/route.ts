// Swap matches for the logged-in student: direct two-student swaps and three-student circles
// (A has X wants Y, B has Y wants Z, C has Z wants X). The graph walk is the database function find_swap_cycles
// (migration 020: books are compared with the same "same book" rule as price alerts, and typed wanted titles count);
// swap_match_suggestions shows each circle once. Items are in circle order: path[i]'s owner receives path[i+1],
// so every book is given to the owner of the previous item, and the first book goes to the last student.
import { handle } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";

export const GET = handle(async () => {
  const user = await requireStudent();
  const cycles = await query("SELECT * FROM swap_match_suggestions($1::int)", [user.id]);
  const ids = Array.from(new Set(cycles.flatMap((c) => c.listing_ids as number[])));
  const listings = ids.length
    ? await query(
        `SELECT l.listing_id, l.title, l.seller_id, s.name AS seller_name
         FROM listing l JOIN student s ON s.student_id = l.seller_id WHERE l.listing_id = ANY($1::int[])`,
        [ids]
      )
    : [];
  const byId = new Map(listings.map((l) => [l.listing_id as number, l]));
  return cycles.map((c) => {
    const path = c.listing_ids as number[];
    const n = path.length;
    return {
      swapType: c.swap_type,
      length: c.cycle_length,
      listingIds: path,
      ringKey: c.ring_key as string,
      alternatives: c.alternatives as number, // other copies of the same books that would make the same circle
      items: path.map((id, j) => {
        const gives = byId.get(path[(j - 1 + n) % n]); // the student who receives path[j]
        const gets = byId.get(path[(j + 1) % n]); // the book path[j]'s owner receives
        return { ...byId.get(id), gives_to: gives?.seller_name, gives_to_id: gives?.seller_id, gets_title: gets?.title, gets_from: gets?.seller_name };
      }),
    };
  });
});

export const dynamic = "force-dynamic";
