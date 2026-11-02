// Runs once before all tests: creates the TEST database if needed and applies the migrations.
// The tests DELETE ALL DATA in that database; tests/testEnv.ts makes sure it can never be a real one.
import { Client } from "pg";
import { runMigrations } from "../lib/db/migrate";
import { assertConnectedToTestDatabase, databaseName, resolveTestDatabaseUrl } from "./testEnv";

export default async function setup() {
  const testUrl = resolveTestDatabaseUrl(); // loads .env files and refuses unsafe targets
  const dbName = databaseName(new URL(testUrl));

  // 1. create the database if it does not exist (connect to the maintenance database "postgres")
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${dbName}"`); // name is validated: a-z, 0-9, _ and ends in _test
  } finally {
    await admin.end();
  }

  // 2. apply migrations
  const client = new Client({ connectionString: testUrl });
  await client.connect();
  try {
    await assertConnectedToTestDatabase(client); // the reset below drops the whole schema
    await runMigrations(client, { reset: true }); // disposable database: always rebuilt from the current SQL
  } finally {
    await client.end();
  }
}
