// Small helpers for route handlers: error mapping, body validation, id parsing.
import { NextResponse } from "next/server";
import { ZodError, ZodTypeAny, z } from "zod";

import { HttpError } from "./errors";
export { HttpError };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handle(fn: (req: Request, ctx: { params: Record<string, string> }) => Promise<unknown>) {
  return async (req: Request, ctx: { params: Record<string, string> }) => {
    try {
      const result = await fn(req, ctx);
      return result instanceof Response ? result : NextResponse.json(result);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

// Explains the most common set-up problems (database not running, wrong password, tables missing)
// instead of a bare "Internal server error". These messages contain no secrets.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setupProblem(err: any): string | null {
  const code = err?.code as string | undefined;
  const msg = String(err?.message ?? "");
  if (!process.env.DATABASE_URL && !process.env.APP_DATABASE_URL)
    return "DATABASE_URL or APP_DATABASE_URL is not set. Configure the database connection in .env.local and restart `npm run dev`.";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT" || code === "ECONNRESET")
    return "Cannot reach the database. Start Docker Desktop, run `docker compose up -d`, check DATABASE_URL in .env.local, then restart `npm run dev`. `npm run doctor` runs a full check.";
  if (code === "28P01" || code === "28000" || msg.includes("client password must be a string"))
    return "The database rejected the login. Check the username, password, host, port and database in APP_DATABASE_URL (or DATABASE_URL if APP_DATABASE_URL is not configured). Update a PostgreSQL role password safely with `\password` in psql; do not delete the database volume.";
  if (code === "3D000")
    return "The database does not exist. Check the database name in DATABASE_URL and run `docker compose up -d`.";
  if (code === "42P01" || code === "42703" || code === "42883")
    return "The database tables are missing or out of date. Back it up first (pg_dump), then run `npm run db:migrate` (keeps your data). Do not run `npm run db:reset` on a database that holds data. `npm run doctor` shows what is wrong.";
  if (msg.includes("SESSION_SECRET"))
    return "SESSION_SECRET is not set (32+ characters) in .env.local. Set it and restart `npm run dev`.";
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function errorResponse(err: any) {
  if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return NextResponse.json(
      { error: `${first.path.join(".") || "input"}: ${first.message}`, details: err.issues },
      { status: 400 }
    );
  }
  // PostgreSQL errors raised by constraints, triggers and functions
  switch (err?.code) {
    case "23514": // check_violation (CHECK constraints and our trigger/function rules)
      return NextResponse.json({ error: err.constraint ? `Rule violated: ${err.constraint}` : err.message }, { status: 400 });
    case "23505": // unique_violation
      return NextResponse.json({ error: err.constraint ? "A record with these details already exists." : err.message }, { status: 409 });
    case "23503": // foreign_key_violation
      return NextResponse.json({ error: "A referenced record does not exist" }, { status: 400 });
    case "23502": // not_null_violation: the API already validated the input, so this means the table has other columns than this code expects
      return NextResponse.json({
        error: `The database does not match this version of the code (column "${err.column ?? "?"}" of table "${err.table ?? "?"}" is required). Back it up first (pg_dump), then run \`npm run db:migrate\` (keeps your data). Do not run \`npm run db:reset\` on a database that holds data.`,
      }, { status: 503 });
    case "22P02": // invalid_text_representation
    case "22003": // numeric_value_out_of_range
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    case "P0002": // no_data_found (raised by our functions)
      return NextResponse.json({ error: err.message }, { status: 404 });
  }
  console.error(err);
  const problem = setupProblem(err);
  if (problem) return NextResponse.json({ error: problem }, { status: 503 });
  // In development the real message helps; in production it stays hidden.
  const detail = process.env.NODE_ENV !== "production" && err?.message ? `: ${err.message}` : "";
  return NextResponse.json({ error: `Internal server error${detail}` }, { status: 500 });
}

export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
  return schema.parse(json);
}

export function parseId(value: string | null | undefined, name = "id"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function searchParams(req: Request) {
  return new URL(req.url).searchParams;
}
