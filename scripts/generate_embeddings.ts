// Generates 384-dimensional embeddings for listings and stores them in listing_embedding (pgvector).
//   npm run embeddings:generate            only new or changed listings
//   npm run embeddings:generate -- --all   recompute every listing
//
// Pipeline: listing fields -> text -> all-MiniLM-L6-v2 -> 384 numbers -> INSERT ... ::vector
// The first run downloads the model from Hugging Face (internet needed once).

import { Client } from "pg";
import { config } from "dotenv";
import { embedText, toVectorLiteral, EMBEDDING_DIMENSION } from "../lib/embeddings/embed";
import { buildListingText, loadListingTextRows } from "../lib/embeddings/listing-text";

config({ path: ".env.local" });
config();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local first.");

  const forceAll = process.argv.includes("--all");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const rows = await loadListingTextRows(client);
    const existing = new Map<number, string>(
      (await client.query("SELECT listing_id, source_text FROM listing_embedding")).rows.map(
        (r) => [r.listing_id as number, r.source_text as string]
      )
    );

    let done = 0;
    let skipped = 0;
    for (const row of rows) {
      const text = buildListingText(row);
      if (!forceAll && existing.get(row.listing_id) === text) {
        skipped++;
        continue;
      }
      const vector = await embedText(text);
      await client.query(
        `INSERT INTO listing_embedding (listing_id, embedding, source_text)
         VALUES ($1, $2::vector, $3)
         ON CONFLICT (listing_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, source_text = EXCLUDED.source_text, updated_at = now()`,
        [row.listing_id, toVectorLiteral(vector), text]
      );
      done++;
      console.log(`embedded listing ${row.listing_id}: ${row.title}`);
    }

    // Safety check: every stored vector must have the dimension the column expects.
    const bad = await client.query(
      "SELECT COUNT(*)::int AS n FROM listing_embedding WHERE vector_dims(embedding) <> $1",
      [EMBEDDING_DIMENSION]
    );
    if (bad.rows[0].n > 0) throw new Error("Found embeddings with the wrong dimension");

    console.log(`Done. embedded: ${done}, unchanged: ${skipped}, dimension: ${EMBEDDING_DIMENSION}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
