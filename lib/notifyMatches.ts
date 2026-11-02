// "Smart" notifications after something changed. Each one is a SQL function (see db/migrations/018_simplify_and_fixes.sql):
//   notify_wanted_book_available(listing)  tells students who want that book that it is open for swapping
//   notify_swap_matches()                  tells students about new two- and three-student swap matches
// The functions only send notifications; they never propose or complete a swap. They run AFTER the main action
// succeeded and a failure here is only logged, so saving a listing never fails because of a notification.
import { query } from "./db/pool";

export async function notifyAfterListingChange(listingId: number) {
  try {
    await query("SELECT notify_wanted_book_available($1::int)", [listingId]);
    await query("SELECT notify_swap_matches()");
  } catch (err) {
    console.error("notifications after listing change failed", err);
  }
}

export async function notifyAfterWantChange() {
  try {
    await query("SELECT notify_swap_matches()");
  } catch (err) {
    console.error("swap match notifications failed", err);
  }
}

// Anything that can create or free up a swap match: a new preference, or a request/proposal that was rejected or
// called off (its listings are available again). Idempotent: students are told once per circle and books.
export const notifyAfterSwapChange = notifyAfterWantChange;
