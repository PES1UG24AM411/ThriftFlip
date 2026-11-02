// Sends e-mail through SMTP (nodemailer).
//
// Two modes:
//   * SMTP mode      SMTP_HOST is set: real e-mails are sent.
//   * dev-link mode  SMTP_HOST is empty AND NODE_ENV is not "production" (that is, `npm run dev`):
//                    nothing is sent; the password-reset link is printed in the terminal and the API
//                    also returns it so the page can show it. Registration and login need NO e-mail at all. This lets you test the whole flow without a mail
//                    server. It is switched off automatically in production.

// APP_URL wins; otherwise the address the request came from (so a dev server on port 3001 gets correct links).
export const appUrl = (origin?: string): string => (process.env.APP_URL ?? origin ?? "http://localhost:3000").replace(/\/$/, "");
export const smtpConfigured = (): boolean => !!process.env.SMTP_HOST;
export const devMailMode = (): boolean => !smtpConfigured() && process.env.NODE_ENV !== "production";

export const resetLink = (token: string, origin?: string): string => `${appUrl(origin)}/reset-password?token=${token}`;

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!smtpConfigured()) {
    if (devMailMode()) console.log(`\n[dev-link mode, e-mail NOT sent]\nTo: ${to}\nSubject: ${subject}\n${text}\n`);
    else console.warn("SMTP_HOST is not set: e-mail was NOT sent");
    return;
  }
  const nodemailer = (await import("nodemailer")).default; // loaded only when a real e-mail is sent
  const port = Number(process.env.SMTP_PORT ?? 587);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transport.sendMail({ from: process.env.MAIL_FROM ?? "THRIFTFLIP <no-reply@thriftflip.local>", to, subject, text });
}

// Returns the link so the caller can show it in dev-link mode.
export async function sendPasswordResetEmail(to: string, token: string, origin?: string): Promise<string> {
  const link = resetLink(token, origin);
  await sendMail(to, "Reset your THRIFTFLIP password",
    `Someone asked to reset your THRIFTFLIP password.\n\nChoose a new password here:\n${link}\n\nThe link works for 1 hour and only once. If it was not you, ignore this message.`);
  return link;
}
