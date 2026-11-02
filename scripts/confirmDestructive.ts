// Shared safety check for the scripts that DELETE data (`npm run db:reset` and `npm run db:seed -- --force`).
// They only continue when the command line repeats the exact name of the database they are about to wipe:
//   npm run db:reset -- --confirm=<database name>
// so a wrong DATABASE_URL (for example one that points at a real or recovered database) can never be wiped by accident.

export function databaseNameOf(databaseUrl: string): string {
  try {
    return decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

export function requireDeleteConfirmation(databaseUrl: string, argv: string[], command: string): void {
  let host = "?";
  try {
    host = new URL(databaseUrl).host;
  } catch {
    /* an unreadable URL is refused below */
  }
  const name = databaseNameOf(databaseUrl);
  const given = argv.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);
  if (name && given === name) return;

  console.error(
    [
      `REFUSED: "${command}" DELETES ALL DATA in the database "${name || "(unknown)"}" on ${host}.`,
      "Nothing was changed.",
      "",
      "If this really is a disposable database (demo data only), repeat the command and type its name:",
      `  ${command} --confirm=${name || "<database name>"}`,
      "",
      "If it holds data you care about, do NOT continue: back it up first (pg_dump) and use `npm run db:migrate`, which keeps your data.",
    ].join("\n")
  );
  process.exit(1);
}
