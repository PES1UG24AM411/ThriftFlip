// `npm run doctor`: checks everything the app needs and says how to fix each problem.
import { existsSync, readdirSync } from "node:fs";
import { Client } from "pg";
import { config } from "dotenv";
import { findStaleMigrations, STALE_HELP } from "../lib/db/migrate";

config({ path: ".env.local" });
config();

let failures = 0;
const ok = (m: string) => console.log(`  OK    ${m}`);
const fail = (m: string, fix: string) => { failures++; console.log(`  FAIL  ${m}\n        -> ${fix}`); };
const info = (m: string) => console.log(`  info  ${m}`);

async function main() {
  console.log("THRIFTFLIP doctor\n");

  console.log("Configuration");
  existsSync(".env.local") ? ok(".env.local exists") : fail(".env.local is missing", "cp .env.example .env.local, then fill it in and restart `npm run dev`");
  const url = process.env.DATABASE_URL;
  url ? ok("DATABASE_URL is set") : fail("DATABASE_URL is not set", "set it in .env.local");
  (process.env.SESSION_SECRET ?? "").length >= 32 ? ok("SESSION_SECRET is set (32+ characters)") : fail("SESSION_SECRET is missing or shorter than 32 characters", "set a long random value in .env.local, e.g. `openssl rand -base64 48`");
  for (const mod of ["bcryptjs", "nodemailer", "jose", "zod", "pg", "next"]) {
    try { require.resolve(mod); ok(`${mod} is installed`); } catch { fail(`${mod} is not installed`, "run `npm install` (delete node_modules first if it keeps failing)"); }
  }
  if ((process.env.SESSION_SECRET ?? "").startsWith("replace_with")) fail("SESSION_SECRET still has the example value", "put your own random string in .env.local (e.g. `openssl rand -base64 48`) and restart `npm run dev`");
  if (process.env.SMTP_HOST) ok(`e-mail: SMTP (${process.env.SMTP_HOST})`);
  else info("e-mail: dev-link mode (no SMTP_HOST): only password-reset links use e-mail; registration and login need none");

  if (!url) return;
  console.log("\nDatabase");
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    ok("connected to PostgreSQL");
  } catch (e) {
    const code = (e as { code?: string }).code;
    fail(`cannot connect (${code ?? (e as Error).message})`,
      code === "28P01" ? "the password in DATABASE_URL differs from the PostgreSQL role password; update the role password safely in psql (do not delete the database volume)"
      : "start Docker Desktop, run `docker compose up -d`, wait 10 seconds, and check the port in DATABASE_URL");
    return;
  }
  try {
    const ext = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    ext.rowCount ? ok("pgvector extension is installed") : info("pgvector extension not installed yet (created by migration 007)");

    const hasMig = (await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t;
    if (!hasMig) { fail("no tables yet", "run `npm run db:migrate`"); return; }
    const stale = await findStaleMigrations(client);
    if (stale.length) { fail(`database built from older SQL files (${stale.join(", ")})`, STALE_HELP.replace(/\n/g, "\n        ")); return; }
    const applied = (await client.query("SELECT COUNT(*)::int AS n FROM schema_migrations")).rows[0].n;
    const available = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).length;
    applied >= available ? ok(`${applied} migrations applied`) : fail(`only ${applied} of ${available} migrations applied`, "back up first (pg_dump), then run `npm run db:migrate` (keeps your data)");

    const campuses = (await client.query("SELECT campus_id, name FROM campus ORDER BY name")).rows;
    campuses.length ? ok(`campuses: ${campuses.map((c) => c.name).join(", ")}`) : fail("no campuses", "run `npm run db:migrate` (migration 008 inserts them)");
    const wanted = ["Biotechnology", "CSE", "CSE (AI & ML)", "ECE", "EEE", "Mechanical"];
    for (const campus of campuses) {
      const depts = (await client.query("SELECT name FROM department WHERE campus_id = $1 ORDER BY name", [campus.campus_id])).rows.map((r) => r.name as string);
      wanted.every((w) => depts.includes(w)) ? ok(`${campus.name} departments: ${depts.join(", ")}`) : fail(`${campus.name} departments found: ${depts.join(", ") || "none"}`, "run `npm run db:migrate` (migration 008 inserts them)");
    }

    process.env.COLLEGE_EMAIL_DOMAINS?.trim() ? info(`registration limited to: ${process.env.COLLEGE_EMAIL_DOMAINS}`) : info("any valid e-mail address can register (set COLLEGE_EMAIL_DOMAINS to restrict it)");

    const counts = (await client.query(
      `SELECT (SELECT COUNT(*)::int FROM student) AS students, (SELECT COUNT(*)::int FROM course) AS courses,
              (SELECT COUNT(*)::int FROM listing) AS listings, (SELECT COUNT(*)::int FROM listing_embedding) AS embeddings`)).rows[0];
    info(`students ${counts.students}, courses ${counts.courses}, listings ${counts.listings}, embeddings ${counts.embeddings}`);
    if (counts.courses === 0) info("no courses yet: `npm run db:seed` adds a demo catalogue (course codes for listings and filters)");
    if (counts.listings > counts.embeddings) info("some listings have no embedding yet: `npm run embeddings:generate`");

    const appUrl = process.env.APP_DATABASE_URL;
    if (!appUrl) {
      info("APP_DATABASE_URL is not set: application-level PostgreSQL role switching is not active yet (see DB_RBAC_SETUP.md)");
    } else {
      const appClient = new Client({ connectionString: appUrl });
      try {
        await appClient.connect();
        const role = (await appClient.query(
          `SELECT r.rolname, r.rolsuper,
                  pg_has_role(current_user, 'thriftflip_student', 'MEMBER') AS student_member,
                  pg_has_role(current_user, 'thriftflip_admin', 'MEMBER') AS admin_member,
                  pg_has_role(current_user, 'thriftflip_auth', 'MEMBER') AS auth_member
             FROM pg_roles r WHERE r.rolname = current_user`
        )).rows[0];
        if (role && !role.rolsuper && role.student_member && role.admin_member && role.auth_member) {
          ok(`APP_DATABASE_URL uses non-superuser role ${role.rolname} with student/admin/auth memberships`);
        } else {
          fail("APP_DATABASE_URL is not configured with the expected non-superuser role memberships", "follow DB_RBAC_SETUP.md; do not use the superuser DATABASE_URL for the app pool");
        }
      } catch (e) {
        fail(`APP_DATABASE_URL connection failed (${(e as { code?: string }).code ?? (e as Error).message})`, "check the thriftflip_app password, host, port and database in .env.local");
      } finally {
        await appClient.end().catch(() => undefined);
      }
    }
  } finally {
    await client.end();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} problem(s) found. Fix the FAIL lines above, then run \`npm run doctor\` again.` : "\nAll checks passed.");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => { console.error(e); process.exit(1); });
