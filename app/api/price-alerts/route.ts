// Price alerts: "tell me when this book is listed at or below my maximum price".
// Who is notified is decided in ONE place, the database function notify_price_alerts_for_listing (migration 019):
// the trigger listing_price_alerts calls it when a listing is created or becomes cheaper / active / better, and
// create_price_alert calls it for the listings that ALREADY exist when the alert is created.
// "Same book" is book_match_percent() (migrations 019 and 021): the same book is 100%, a similar title from 70% upwards.
import { NextResponse } from "next/server";
import { handle, parseBody, parseId, searchParams } from "@/lib/http";
import { query } from "@/lib/db/pool";
import { requireStudent } from "@/lib/auth/session";
import { alertCreateSchema } from "@/lib/validation/schemas";

// My alerts, each with the fixed-price listings that match it right now: the same book (or a very similar title, with a
// match percentage from book_match_percent), price at or below my maximum, good enough condition, not mine.
export const GET = handle(async () => {
  const user = await requireStudent();
  return query(
    `SELECT a.alert_id, a.max_price, a.min_condition, a.created_at, a.triggered_at, b.book_id, b.title,
            COALESCE((SELECT json_agg(json_build_object('listing_id', l.listing_id, 'title', l.title, 'price', l.price, 'condition', l.item_condition,
                                                         'match_percent', m.pct, 'seller_id', l.seller_id, 'seller_name', s.name)
                                      ORDER BY m.pct DESC, l.price)
                      FROM listing l
                      JOIN student s ON s.student_id = l.seller_id
                      CROSS JOIN LATERAL (SELECT book_match_percent(a.book_id, l.book_id) AS pct) m
                      WHERE l.status = 'ACTIVE' AND l.listing_type = 'FIXED_PRICE'
                        AND l.price <= a.max_price AND l.seller_id <> $1
                        AND m.pct >= price_alert_min_match()
                        AND (a.min_condition IS NULL OR condition_rank(l.item_condition) >= condition_rank(a.min_condition))), '[]'::json) AS matches
     FROM price_alert a JOIN book b ON b.book_id = a.book_id
     WHERE a.student_id = $1 ORDER BY a.created_at DESC`,
    [user.id]
  );
});

export const POST = handle(async (req) => {
  const user = await requireStudent();
  const b = await parseBody(req, alertCreateSchema);
  // stores the alert and notifies about listings that are already cheap enough (once per listing and price)
  const rows = await query("SELECT create_price_alert($1::int, $2::int, $3::numeric, $4::text) AS id", [user.id, b.bookId, b.maxPrice, b.condition ?? null]);
  return NextResponse.json({ id: rows[0].id }, { status: 201 });
});

export const DELETE = handle(async (req) => {
  const user = await requireStudent();
  await query("DELETE FROM price_alert WHERE alert_id = $1 AND student_id = $2", [
    parseId(searchParams(req).get("id")), user.id,
  ]);
  return { ok: true };
});

export const dynamic = "force-dynamic";
