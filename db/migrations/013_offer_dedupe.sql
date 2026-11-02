-- 013_offer_dedupe.sql
-- A student could send the same offer several times (double click, repeated request): every copy created another
-- row and another notification for the seller. From now on a student can have only ONE pending offer per listing.
-- Existing duplicate pending offers (if any) are not deleted: the older copies are marked WITHDRAWN, the newest stays.
UPDATE offer o SET status = 'WITHDRAWN', responded_at = now()
WHERE o.status = 'PENDING'
  AND EXISTS (SELECT 1 FROM offer n
              WHERE n.listing_id = o.listing_id AND n.buyer_id = o.buyer_id AND n.status = 'PENDING'
                AND n.offer_id > o.offer_id);

CREATE UNIQUE INDEX uq_offer_one_pending ON offer (listing_id, buyer_id) WHERE status = 'PENDING';
