// npm run admin:create -- "Full Name" admin@example.com "a-strong-password"
// The only way to create an administrator. Students can never become admins through the website.
// If the e-mail already belongs to an admin, the name and password are updated (use this to reset a password).
import { Client } from "pg";
import { config } from "dotenv";
import bcrypt from "bcryptjs";

config({ path: ".env.local" });
config();

async function main() {
  const [name, rawEmail, password] = process.argv.slice(2);
  if (!name || !rawEmail || !password) {
    console.error('Usage: npm run admin:create -- "Full Name" admin@example.com "password (8+ characters)"');
    process.exit(1);
  }
  const email = rawEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("That e-mail address does not look right");
  if (name.trim().length < 2) throw new Error("Please give the admin's name");
  if (password.length < 8) throw new Error("The password needs at least 8 characters");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set (.env.local)");

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    if ((await c.query("SELECT 1 FROM student WHERE lower(email) = $1", [email])).rowCount) {
      throw new Error("That e-mail belongs to a student account. Use a different e-mail for the admin.");
    }
    const hash = await bcrypt.hash(password, 10);
    const r = await c.query(
      `INSERT INTO admin (name, email, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash
       RETURNING (xmax = 0) AS created`,
      [name.trim(), email, hash]
    );
    console.log(r.rows[0].created ? `Admin created: ${email}` : `Admin already existed, name and password updated: ${email}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
