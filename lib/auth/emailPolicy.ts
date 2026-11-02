// Optional college-e-mail restriction for registration.
//
//   COLLEGE_EMAIL_DOMAINS=pes.edu,pesu.pes.edu     only these domains (and their sub-domains) may register
//   COLLEGE_EMAIL_DOMAINS=                         (empty or not set) ANY valid e-mail address may register
//
// Nothing else about e-mail changes: the format is still checked (Zod + CHECK constraint), the address is still unique.
// E-mail is NOT verified by a link any more; this policy is the only e-mail rule left.
export function allowedEmailDomains(raw: string | undefined = process.env.COLLEGE_EMAIL_DOMAINS): string[] {
  return (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export function isEmailAllowed(email: string, domains: string[] = allowedEmailDomains()): boolean {
  if (domains.length === 0) return true;
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return domains.some((d) => domain === d || domain.endsWith("." + d));
}

export const collegeEmailMessage = (domains: string[] = allowedEmailDomains()): string =>
  `Please use your college e-mail address (${domains.map((d) => "@" + d).join(", ")}).`;
