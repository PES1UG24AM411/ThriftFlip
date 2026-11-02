import { describe, expect, it } from "vitest";
import { allowedEmailDomains, isEmailAllowed } from "../lib/auth/emailPolicy";

describe("college e-mail policy (COLLEGE_EMAIL_DOMAINS)", () => {
  it("is off by default: any valid e-mail may register", () => {
    expect(allowedEmailDomains(undefined)).toEqual([]);
    expect(allowedEmailDomains("  ")).toEqual([]);
    expect(isEmailAllowed("someone@gmail.com", [])).toBe(true);
  });

  it("when set, only those domains and their sub-domains are accepted", () => {
    const d = allowedEmailDomains("PES.edu, @pesu.pes.edu ,");
    expect(d).toEqual(["pes.edu", "pesu.pes.edu"]);
    expect(isEmailAllowed("a@pes.edu", d)).toBe(true);
    expect(isEmailAllowed("A@Student.PES.edu", d)).toBe(true);
    expect(isEmailAllowed("a@gmail.com", d)).toBe(false);
    expect(isEmailAllowed("a@notpes.edu", d)).toBe(false); // not a sub-domain, just a similar name
    expect(isEmailAllowed("a@pes.edu.evil.com", d)).toBe(false);
  });
});
