// Embeds one listing and stores the vector in listing_embedding (called after create/edit).
import { pool } from "../db/pool";
import { embedText, toVectorLiteral } from "./embed";
import { buildListingText, loadListingTextRows } from "./listing-text";

export async function upsertListingEmbedding(listingId: number): Promise<void> {
  const rows = await loadListingTextRows(pool, listingId);
  if (!rows[0]) return;
  const text = buildListingText(rows[0]);
  const vector = await embedText(text);
  await pool.query(
    `INSERT INTO listing_embedding (listing_id, embedding, source_text)
     VALUES ($1, $2::vector, $3)
     ON CONFLICT (listing_id) DO UPDATE
       SET embedding = EXCLUDED.embedding, source_text = EXCLUDED.source_text, updated_at = now()`,
    [listingId, toVectorLiteral(vector), text]
  );
}
