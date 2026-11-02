import { afterEach, describe, expect, it } from "vitest";
import { appUrl, devMailMode, resetLink, smtpConfigured } from "../lib/email";
import { hashToken, newToken } from "../lib/auth/tokens";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["SMTP_HOST", "APP_URL"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  (process.env as Record<string, string | undefined>).NODE_ENV = saved.NODE_ENV;
});

describe("e-mail modes and links", () => {
  it("dev-link mode is on only without SMTP and outside production", () => {
    delete process.env.SMTP_HOST;
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    expect(smtpConfigured()).toBe(false);
    expect(devMailMode()).toBe(true);
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(devMailMode()).toBe(false); // links are never shown on screen in production
    process.env.SMTP_HOST = "smtp.example.com";
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    expect(smtpConfigured()).toBe(true);
    expect(devMailMode()).toBe(false);
  });

  it("builds the password-reset link from APP_URL", () => {
    process.env.APP_URL = "https://thriftflip.example.edu/";
    expect(appUrl()).toBe("https://thriftflip.example.edu");
    expect(resetLink("abc")).toBe("https://thriftflip.example.edu/reset-password?token=abc");
  });

  it("without APP_URL the link uses the address the request came from", () => {
    delete process.env.APP_URL;
    expect(resetLink("abc", "http://localhost:3001")).toBe("http://localhost:3001/reset-password?token=abc");
    expect(resetLink("abc")).toBe("http://localhost:3000/reset-password?token=abc");
  });

  it("tokens are 256-bit random and hashed with SHA-256", () => {
    const a = newToken(), b = newToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(a);
  });
});
