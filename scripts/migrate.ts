// npm run db:migrate   applies new migrations
// npm run db:reset -- --confirm=<database name>
//                      drops everything, then applies all migrations (DELETES ALL DATA; refuses without --confirm)
import { Client } from "pg";
import { config } from "dotenv";
import { runMigrations } from "../lib/db/migrate";
import { requireDeleteConfirmation } from "./confirmDestructive";

config({ path: ".env.local" });
config();

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local first.");
  const reset = process.argv.includes("--reset");
  if (reset) requireDeleteConfirmation(databaseUrl, process.argv, "npm run db:reset --");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await runMigrations(client, { reset, log: console.log });
    console.log("Migrations finished.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
