// Applies every SQL file in db/migrations/ (in name order) and records it in schema_migrations.
// Each file runs in its own transaction: if one statement fails, that file is rolled back.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

// Migrations that were applied from a DIFFERENT version of the SQL file than the one on disk
// (or by a version that did not record checksums). Applying new files on top of them would give a broken schema.
export async function findStaleMigrations(client: Client): Promise<string[]> {
  const exists = (await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
  if (!exists) return [];
  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
  const rows = (await client.query("SELECT filename, checksum FROM schema_migrations ORDER BY filename")).rows;
  const stale: string[] = [];
  for (const r of rows) {
    let current: string | null = null;
    try {
      current = checksum(readFileSync(path.join(MIGRATIONS_DIR, r.filename), "utf8"));
    } catch {
      continue; // file no longer exists: ignore
    }
    if (!r.checksum || r.checksum !== current) stale.push(r.filename as string);
  }
  return stale;
}

export const STALE_HELP =
  "An already-applied migration file no longer matches what is recorded in the database.\n" +
  "Do NOT reset anything yet. Safe recovery plan:\n" +
  "  1. Back up first:   pg_dump \"$DATABASE_URL\" > backup.sql\n" +
  "  2. Restore the original text of the named migration file(s) (git checkout / your ZIP): applied files must never be edited,\n" +
  "     new changes belong in a NEW numbered file.\n" +
  "  3. Only if the database holds nothing worth keeping (demo data), you may rebuild it:  npm run db:reset -- --confirm=<database name>  then  npm run db:seed\n" +
  "     (this DELETES all data; the reset refuses to run without --confirm).";

export async function runMigrations(
  client: Client,
  opts: { reset?: boolean; log?: (message: string) => void } = {}
) {
  const log = opts.log ?? (() => {});
  if (opts.reset) {
    log("Resetting database (DROP SCHEMA public CASCADE)...");
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT");
  if (!opts.reset) {
    const stale = await findStaleMigrations(client);
    if (stale.length > 0) throw new Error(`Migration files changed since they were applied: ${stale.join(", ")}\n${STALE_HELP}`);
  }

  await client.query("SELECT pg_advisory_lock(727274)"); // two terminals cannot migrate at once
  try {
    const applied = new Set(
      (await client.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename as string)
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) {
        log(`skip     ${file}`);
        continue;
      }
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [file, checksum(sql)]);
        await client.query("COMMIT");
        log(`applied  ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        log(`FAILED   ${file}`);
        throw err;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)");
  }
}
