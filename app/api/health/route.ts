// Quick self-check for set-up problems: open http://localhost:3000/api/health
// (production returns only {ok}).
import { NextResponse } from "next/server";
import { query } from "@/lib/db/pool";
import { smtpConfigured } from "@/lib/email";
import { allowedEmailDomains } from "@/lib/auth/emailPolicy";

export async function GET() {
  const checks: Record<string, unknown> = {
    databaseUrlSet: !!process.env.DATABASE_URL,
    sessionSecretSet: (process.env.SESSION_SECRET ?? "").length >= 32,
    emailMode: smtpConfigured() ? "smtp" : "dev-link (no SMTP: password-reset links appear on screen and in the terminal)",
    collegeEmailDomains: allowedEmailDomains().length ? allowedEmailDomains() : "any e-mail address may register",
  };
  try {
    const bcrypt = (await import("bcryptjs")).default;
    checks.passwordHashing = (await bcrypt.compare("x", await bcrypt.hash("x", 4))) ? "ok" : "broken";
  } catch (e) {
    checks.passwordHashing = `FAILED: ${(e as Error).message}`;
  }
  try {
    await query("SELECT 1");
    checks.databaseConnected = true;
    const t = await query(
      `SELECT to_regclass('public.college_email_domain') IS NOT NULL AS has_domains,
              to_regclass('public.auth_token') IS NOT NULL AS has_tokens,
              to_regclass('public.swap_proposal') IS NOT NULL AS has_swap_proposals`
    );
    checks.schemaUpToDate = !!(t[0].has_domains && t[0].has_tokens && t[0].has_swap_proposals);
    if (checks.schemaUpToDate) {
      checks.campuses = (await query("SELECT name FROM campus ORDER BY name")).map((r) => r.name);
      checks.departments = (await query("SELECT DISTINCT name FROM department ORDER BY name")).map((r) => r.name);
    } else {
      checks.advice = "Run: npm run db:migrate (adds the newest tables and keeps your data). Do NOT run db:reset unless you accept losing all data.";
    }
  } catch (e) {
    checks.databaseConnected = false;
    checks.databaseError = (e as { code?: string }).code ?? "unknown";
    checks.advice = "Start the database: docker compose up -d. Then run: npm run doctor";
  }
  checks.ok = !!(checks.passwordHashing === "ok" && checks.databaseUrlSet && checks.sessionSecretSet && checks.databaseConnected && checks.schemaUpToDate);
  if (process.env.NODE_ENV === "production") return NextResponse.json({ ok: checks.ok });
  return NextResponse.json(checks);
}

export const dynamic = "force-dynamic";
