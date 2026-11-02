// Decides which database the tests use and refuses anything that could be a real one.
// The tests TRUNCATE every table (and globalSetup rebuilds the schema), so a mistake here would destroy data.
//
// Rules (all must hold, otherwise an Error explains what to change):
//   1. TEST_DATABASE_URL comes from the environment, .env.test, .env.local or .env (in that order of priority).
//      If it is missing, it is derived from DATABASE_URL by switching to the database `thriftflip_test`
//      on the same local server (your development database itself is never touched).
//   2. The database name must end in "_test" and contain only a-z, 0-9 and _.
//   3. It must not be the same database as DATABASE_URL (host, port and name are compared, not just the text).
//   4. The server must be local (localhost / 127.0.0.1 / ::1 / host.docker.internal) unless ALLOW_REMOTE_TEST_DB=1.
//   5. Never when NODE_ENV is "production".
import { config } from "dotenv";
import type { Client, Pool } from "pg";

export const DEFAULT_TEST_DB = "thriftflip_test";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

let loaded = false;
function loadEnvFiles() {
  if (loaded) return;
  loaded = true;
  // dotenv never overwrites a variable that is already set, so the first file listed wins.
  config({ path: ".env.test" });
  config({ path: ".env.local" });
  config();
}

function parse(label: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid connection URL (expected postgresql://user:password@host:5432/dbname).`);
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") throw new Error(`${label} must start with postgresql://`);
  return url;
}

export const databaseName = (url: URL) => decodeURIComponent(url.pathname.replace(/^\//, ""));
const isLocal = (host: string) => LOCAL_HOSTS.has(host.toLowerCase());
// localhost, 127.0.0.1 and ::1 are the same machine: treat them as one host when comparing targets
const hostKey = (host: string) => (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host.toLowerCase()) ? "local" : host.toLowerCase());
const target = (url: URL) => `${hostKey(url.hostname)}:${url.port || "5432"}/${databaseName(url)}`;

/** Throws unless `testUrl` is a safe, separate test database. Pure function: no connection is made. */
export function assertSafeTestDatabase(testUrl: string, devUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): URL {
  if (env.NODE_ENV === "production") throw new Error("Refusing to run tests with NODE_ENV=production.");
  const url = parse("TEST_DATABASE_URL", testUrl);
  const name = databaseName(url);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Test database name "${name}" may only contain a-z, 0-9 and _.`);
  if (!name.endsWith("_test")) {
    throw new Error(`Test database name must end with "_test" (use "${DEFAULT_TEST_DB}"), but TEST_DATABASE_URL points to "${name}". Tests delete all data in it.`);
  }
  if (devUrl) {
    const dev = parse("DATABASE_URL", devUrl);
    if (target(dev) === target(url)) throw new Error("TEST_DATABASE_URL points to the same database as DATABASE_URL. Tests delete all data, so they need their own database.");
  }
  if (!isLocal(url.hostname) && env.ALLOW_REMOTE_TEST_DB !== "1") {
    throw new Error(`TEST_DATABASE_URL points to a non-local server ("${url.hostname}"). Tests only run against a local database. Set ALLOW_REMOTE_TEST_DB=1 only if this really is a disposable remote test database.`);
  }
  return url;
}

/** Derives the test URL from the dev URL: same server and login, database `thriftflip_test`. */
export function deriveTestUrl(devUrl: string): string {
  const url = parse("DATABASE_URL", devUrl);
  url.pathname = `/${DEFAULT_TEST_DB}`;
  return url.toString();
}

/** Loads the env files, validates and returns the test database URL (also stores it in process.env). */
export function resolveTestDatabaseUrl(): string {
  loadEnvFiles();
  const dev = process.env.DATABASE_URL;
  let testUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!testUrl) {
    if (!dev) {
      throw new Error(
        "TEST_DATABASE_URL is not set. Add it to .env.local (see .env.example), for example:\n" +
          `  TEST_DATABASE_URL=postgresql://thriftflip:<your-password>@localhost:5432/${DEFAULT_TEST_DB}`
      );
    }
    testUrl = deriveTestUrl(dev);
    console.warn(`[tests] TEST_DATABASE_URL is not set: using database "${DEFAULT_TEST_DB}" on the same server as DATABASE_URL.`);
  }
  assertSafeTestDatabase(testUrl, dev);
  process.env.TEST_DATABASE_URL = testUrl;
  return testUrl;
}

/** Last line of defence: asks the connected server which database it really is before anything is deleted. */
export async function assertConnectedToTestDatabase(db: Pool | Client) {
  const name = String((await db.query("SELECT current_database() AS name")).rows[0].name);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`Refusing to delete data: connected database "${name}" is not a test database (name must end in "_test").`);
  const dev = process.env.DATABASE_URL ? databaseName(parse("DATABASE_URL", process.env.DATABASE_URL)) : null;
  if (dev && name === dev) throw new Error(`Refusing to delete data: connected database "${name}" is the development database.`);
}
