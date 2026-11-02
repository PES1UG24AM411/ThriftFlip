import { handle, parseBody } from "@/lib/http";
import { pool, queryOne } from "@/lib/db/pool";
import { forgotSchema } from "@/lib/validation/schemas";
import { issueToken } from "@/lib/auth/service";
import { devMailMode, sendPasswordResetEmail } from "@/lib/email";

// Always answers the same way so the page cannot be used to find out which e-mails are registered.
export const POST = handle(async (req) => {
  const { email } = await parseBody(req, forgotSchema);
  const student = await queryOne<{ student_id: number; status: string }>(
    "SELECT student_id, status FROM student WHERE email = $1", [email]);
  let link: string | null = null;
  if (student && student.status === "ACTIVE") {
    const token = await issueToken(pool, student.student_id, "RESET_PASSWORD", 60);
    link = await sendPasswordResetEmail(email, token, new URL(req.url).origin).catch((e) => { console.error("reset e-mail failed", e); return null; });
  }
  // devResetLink exists only in development without SMTP (and only for registered e-mails)
  return {
    ok: true,
    message: "If that e-mail is registered, a reset link has been sent.",
    devResetLink: devMailMode() && link ? link : undefined,
  };
});

export const dynamic = "force-dynamic";
