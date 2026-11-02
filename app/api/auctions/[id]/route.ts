import { handle, HttpError, parseId } from "@/lib/http";
import { query, queryOne } from "@/lib/db/pool";
import { requireUser } from "@/lib/auth/session";

export const GET = handle(async (_req, ctx) => {
  const user = await requireUser();
  const id = parseId(ctx.params.id);
  await query("SELECT close_expired_auctions()");

  const auction = await queryOne("SELECT * FROM v_auction_status WHERE auction_id = $1", [id]);
  if (!auction) throw new HttpError(404, "Auction not found");
  const isSeller = user.role === "STUDENT" && auction.seller_id === user.id;
  const canSeeNames = isSeller || user.role === "ADMIN";

  const bids = await query(
    `SELECT b.bid_id, b.bidder_id, b.amount, b.placed_at, b.status, b.seconds_before_end, s.name
     FROM bid b JOIN student s ON s.student_id = b.bidder_id
     WHERE b.auction_id = $1
     ORDER BY b.placed_at DESC, b.bid_id DESC`,
    [id]
  );
  const visible = bids
    .filter((b) => canSeeNames || b.status === "VALID")
    .map((b) => ({
      bid_id: b.bid_id,
      amount: b.amount,
      placed_at: b.placed_at,
      status: b.status,
      seconds_before_end: canSeeNames ? b.seconds_before_end : null,
      bidder: canSeeNames ? b.name : `Bidder #${b.bidder_id}`,
      isMine: user.role === "STUDENT" && b.bidder_id === user.id,
    }));
  return { auction, bids: visible, isSeller, minNextBid: auction.highest_bidder_id ? Number(auction.current_price) + Number(auction.min_increment) : Number(auction.starting_price) };
});

export const dynamic = "force-dynamic";
