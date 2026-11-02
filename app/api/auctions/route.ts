import { handle } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";

export const GET = handle(async () => {
  await requireStudent();
  await query("SELECT close_expired_auctions()"); // finished auctions are closed (winner chosen) on access
  return query(
    `SELECT a.auction_id, a.listing_id, a.title, a.current_price, a.starting_price, a.min_increment,
            a.end_time, a.seconds_left, a.bid_count, a.extension_count, a.highest_bidder_id,
            d.seller_id, d.seller_name, d.item_condition, d.author, d.campus_name
     FROM v_auction_status a
     JOIN v_listing_details d ON d.listing_id = a.listing_id
     WHERE a.status = 'ACTIVE'
     ORDER BY a.end_time`
  );
});

export const dynamic = "force-dynamic";
