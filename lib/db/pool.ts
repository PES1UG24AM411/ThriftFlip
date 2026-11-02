// Shared PostgreSQL pool. When APP_DATABASE_URL is configured, each statement runs
// in a short transaction with a least-privilege PostgreSQL role selected from the
// signed server-side session cookie. DATABASE_URL remains the owner/migration URL.
import { Pool } from "pg";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "../auth/token";

if (!process.env.DATABASE_URL && !process.env.APP_DATABASE_URL) {
  console.error("DATABASE_URL or APP_DATABASE_URL must be set.");
}

const appDatabaseUrl = process.env.APP_DATABASE_URL;
const connectionString = appDatabaseUrl || process.env.DATABASE_URL;
if (!appDatabaseUrl && process.env.NODE_ENV !== "test") {
  console.warn("APP_DATABASE_URL is not set. Database role switching is inactive; configure it after running the RBAC setup.");
}

const globalForPg = globalThis as unknown as { pgPool?: Pool };
const rawPool: Pool = globalForPg.pgPool ?? new Pool({ connectionString, max: 10 });
if (process.env.NODE_ENV !== "production") globalForPg.pgPool = rawPool;

type DbPrincipal = { role: "thriftflip_student" | "thriftflip_admin" | "thriftflip_auth"; id: number | null; appRole: "STUDENT" | "ADMIN" | "AUTH" };

async function currentPrincipal(): Promise<DbPrincipal> {
  try {
    const token = cookies().get(COOKIE_NAME)?.value;
    if (!token) return { role: "thriftflip_auth", id: null, appRole: "AUTH" };
    const session = await verifyToken(token);
    if (!session) return { role: "thriftflip_auth", id: null, appRole: "AUTH" };
    return session.role === "ADMIN"
      ? { role: "thriftflip_admin", id: session.id, appRole: "ADMIN" }
      : { role: "thriftflip_student", id: session.id, appRole: "STUDENT" };
  } catch {
    // Outside a Next.js request (migration/maintenance scripts), do not try to
    // infer an application user. Those scripts should use DATABASE_URL directly.
    return { role: "thriftflip_auth", id: null, appRole: "AUTH" };
  }
}

async function applyPrincipal(client: PoolClient, principal: DbPrincipal): Promise<void> {
  // Role names are fixed constants, never user input.
  await client.query(`SET LOCAL ROLE ${principal.role}`);
  await client.query("SELECT set_config('app.user_id', $1, true), set_config('app.user_role', $2, true)", [
    principal.id === null ? "" : String(principal.id), principal.appRole,
  ]);
}

async function scopedQuery<R extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<R>> {
  if (!appDatabaseUrl) return rawPool.query<R>(text, values);
  const client = await rawPool.connect();
  try {
    await client.query("BEGIN");
    await applyPrincipal(client, await currentPrincipal());
    const result = await client.query<R>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Preserve the familiar Pool API used by authentication helpers and embeddings,
// while ensuring pool.query() also receives the request's database role.
export const pool: Pool = new Proxy(rawPool, {
  get(target, property) {
    if (property === "query") return scopedQuery;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await scopedQuery(text, params as any[]);
  return result.rows as T[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function queryOne<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await rawPool.connect();
  try {
    await client.query("BEGIN");
    if (appDatabaseUrl) await applyPrincipal(client, await currentPrincipal());
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
