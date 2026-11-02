import { handle, HttpError, parseBody, parseId, searchParams } from "@/lib/http";
import { query, queryOne, withTransaction } from "@/lib/db/pool";
import { saveWantedBooks } from "@/lib/wanted";
import { requireStudent, requireUser } from "@/lib/auth/session";
import { listingUpdateSchema } from "@/lib/validation/schemas";
import { upsertListingEmbedding } from "@/lib/embeddings/store";
import { notifyAfterListingChange } from "@/lib/notifyMatches";

export const GET = handle(async (req, ctx) => {
  const session = await requireUser(); // logged in AND the account still exists / is not suspended (like every other route)
  const id = parseId(ctx.params.id);
  // ?poll=1 = the page refreshing itself in the background (every 2 seconds): same data, but it is not a new "view"
  const isBackgroundRefresh = searchParams(req).get("poll") === "1";

  const listing = await queryOne("SELECT * FROM v_listing_details WHERE listing_id = $1", [id]);
  if (!listing) throw new HttpError(404, "Listing not found");
  const isOwner = session.role === "STUDENT" && listing.seller_id === session.id;
  if (listing.status === "REMOVED" && !isOwner && session.role !== "ADMIN") throw new HttpError(404, "Listing not found");

  const fairPrice = listing.book_id
    ? await queryOne("SELECT * FROM calculate_fair_price($1, $2)", [listing.book_id, listing.item_condition])
    : null;
  const similar = await query("SELECT * FROM similar_listings($1, 5)", [id]);

  let inWishlist = false;
  if (session.role === "STUDENT") {
    inWishlist = !!(await queryOne("SELECT 1 FROM wishlist WHERE student_id = $1 AND listing_id = $2", [session.id, id]));
    if (!isOwner && !isBackgroundRefresh) {
      // every view feeds "recently viewed", demand analytics and recommendations
      await query("SELECT touch_recently_viewed($1::int, $2::int)", [session.id, id]);
      if (listing.book_id) {
        await query(
          `INSERT INTO search_activity (student_id, search_type, book_id, course_id) VALUES ($1, 'VIEW', $2, $3)`,
          [session.id, listing.book_id, listing.course_id]
        );
      }
    }
  }

  const images = await query("SELECT image_id FROM listing_image WHERE listing_id = $1 ORDER BY position, image_id", [id]);
  // Seller information. The preferred contact detail is shown only if the seller allowed it.
  const seller = await queryOne(
    `SELECT s.student_id AS id, s.name, d.name AS department, s.semester, s.contact_preference,
            CASE WHEN s.show_contact THEN
              CASE s.contact_preference WHEN 'PHONE' THEN s.phone WHEN 'EMAIL' THEN s.email END
            END AS contact,
            (SELECT image_id FROM image WHERE owner_id = s.student_id AND purpose = 'PROFILE') AS profile_image_id,
            r.completed_transactions, r.rating_count, r.avg_rating
     FROM student s JOIN department d ON d.department_id = s.department_id
     JOIN v_student_ratings r ON r.student_id = s.student_id
     WHERE s.student_id = $1`,
    [listing.seller_id]
  );
  // books the seller wants in return: the list typed on the listing form plus the "What I want in return"
  // preferences of the Swaps page (swap_preference, which is also what swap matching uses), without duplicates
  const wanted = await query(
    `SELECT x.wanted_id, x.book_id, x.title, x.author FROM (
       SELECT w.wanted_id, w.book_id, COALESCE(b.title, w.custom_title) AS title, b.author
         FROM listing_wanted_book w LEFT JOIN book b ON b.book_id = w.book_id WHERE w.listing_id = $1
       UNION ALL
       SELECT 1000000 + sp.preference_id, sp.wanted_book_id, b.title, b.author
         FROM swap_preference sp JOIN book b ON b.book_id = sp.wanted_book_id
        WHERE sp.offered_listing_id = $1
          AND NOT EXISTS (SELECT 1 FROM listing_wanted_book w2 WHERE w2.listing_id = $1 AND w2.book_id = sp.wanted_book_id)
     ) x ORDER BY x.wanted_id`,
    [id]
  );
  return { listing, images, seller, fairPrice, similar, inWishlist, isOwner, wanted };
});

export const PUT = handle(async (req, ctx) => {
  const user = await requireStudent();
  const id = parseId(ctx.params.id);
  const b = await parseBody(req, listingUpdateSchema);
  const rows = await query(
    `UPDATE listing SET
        title = COALESCE($3::text, title),
        description = COALESCE($4::text, description),
        item_condition = COALESCE($5::text, item_condition),
        price = COALESCE($6::numeric, price),
        open_to_swap = COALESCE($7::boolean, open_to_swap)
     WHERE listing_id = $1 AND seller_id = $2 AND status = 'ACTIVE'
       AND (listing_type = 'FIXED_PRICE'
            OR ($6::numeric IS NULL AND NOT EXISTS (SELECT 1 FROM bid bi JOIN auction a ON a.auction_id = bi.auction_id
                                                    WHERE a.listing_id = listing.listing_id)))
     RETURNING listing_id`,
    [id, user.id, b.title ?? null, b.description ?? null, b.condition ?? null, b.price ?? null, b.openToSwap ?? null]
  );
  if (rows.length === 0) throw new HttpError(409, "Listing not found, not yours, or it can no longer be edited");
  if (b.wantedBooks !== undefined || b.openToSwap === false) {
    await withTransaction(async (c) => {
      const open = (await c.query("SELECT open_to_swap FROM listing WHERE listing_id = $1", [id])).rows[0].open_to_swap as boolean;
      if (b.wantedBooks === undefined) await c.query("DELETE FROM listing_wanted_book WHERE listing_id = $1", [id]);
      else await saveWantedBooks(c, id, open, b.wantedBooks);
    });
  }
  upsertListingEmbedding(id).catch((e) => console.error("embedding failed", e));
  await notifyAfterListingChange(id); // e.g. the listing was just opened for swapping
  return { ok: true };
});

// "Delete" keeps the row (transactions and bids reference it) and sets status REMOVED.
export const DELETE = handle(async (_req, ctx) => {
  const user = await requireStudent();
  const id = parseId(ctx.params.id);
  const rows = await query(
    `UPDATE listing SET status = 'REMOVED'
     WHERE listing_id = $1 AND seller_id = $2 AND status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM bid bi JOIN auction a ON a.auction_id = bi.auction_id WHERE a.listing_id = listing.listing_id)
     RETURNING listing_id`,
    [id, user.id]
  );
  if (rows.length === 0) throw new HttpError(409, "Only your own active listings without bids can be deleted");
  return { ok: true };
});

export const dynamic = "force-dynamic";
