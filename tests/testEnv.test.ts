import { describe, expect, it } from "vitest";
import { assertConnectedToTestDatabase, assertSafeTestDatabase, deriveTestUrl } from "./testEnv";

const DEV = "postgresql://thriftflip:pw@localhost:5432/thriftflip";
const env = (over: Record<string, string> = {}) => ({ NODE_ENV: "test", ...over }) as NodeJS.ProcessEnv;

describe("test database safeguards", () => {
  it("accepts a separate local database ending in _test", () => {
    expect(() => assertSafeTestDatabase("postgresql://thriftflip:pw@localhost:5432/thriftflip_test", DEV, env())).not.toThrow();
  });

  it("derives thriftflip_test on the same server from DATABASE_URL (the dev database is never used)", () => {
    const derived = deriveTestUrl(DEV);
    expect(new URL(derived).pathname).toBe("/thriftflip_test");
    expect(() => assertSafeTestDatabase(derived, DEV, env())).not.toThrow();
  });

  it("refuses the development database, also written with another host spelling", () => {
    expect(() => assertSafeTestDatabase(DEV, DEV, env())).toThrow(/_test|same database/);
    expect(() => assertSafeTestDatabase("postgresql://thriftflip:pw@127.0.0.1:5432/thriftflip", DEV, env())).toThrow(/_test|same database/);
    // even a name ending in _test is refused when the dev URL points to it
    const devTest = "postgresql://thriftflip:pw@localhost:5432/other_test";
    expect(() => assertSafeTestDatabase("postgresql://thriftflip:pw@127.0.0.1/other_test", devTest, env())).toThrow(/same database/);
  });

  it("refuses names that do not end in _test, odd names, non-local hosts, production and bad URLs", () => {
    expect(() => assertSafeTestDatabase("postgresql://u:p@localhost:5432/production", DEV, env())).toThrow(/_test/);
    expect(() => assertSafeTestDatabase("postgresql://u:p@localhost:5432/postgres", DEV, env())).toThrow(/_test/);
    expect(() => assertSafeTestDatabase("postgresql://u:p@localhost:5432/Thrift-Test", DEV, env())).toThrow(/only contain/);
    expect(() => assertSafeTestDatabase("postgresql://u:p@db.example.com:5432/thriftflip_test", DEV, env())).toThrow(/non-local/);
    expect(() => assertSafeTestDatabase("postgresql://u:p@db.example.com:5432/thriftflip_test", DEV, env({ ALLOW_REMOTE_TEST_DB: "1" }))).not.toThrow();
    expect(() => assertSafeTestDatabase("postgresql://u:p@localhost:5432/thriftflip_test", DEV, env({ NODE_ENV: "production" }))).toThrow(/production/);
    expect(() => assertSafeTestDatabase("not a url", DEV, env())).toThrow(/valid connection URL/);
    expect(() => assertSafeTestDatabase("mysql://u:p@localhost/thriftflip_test", DEV, env())).toThrow(/postgresql/);
  });

  it("asks the connected server for its real database name before anything is deleted", async () => {
    const fake = (name: string) => ({ query: async () => ({ rows: [{ name }] }) }) as never;
    await expect(assertConnectedToTestDatabase(fake("thriftflip_test"))).resolves.toBeUndefined();
    await expect(assertConnectedToTestDatabase(fake("thriftflip"))).rejects.toThrow(/not a test database/);
    await expect(assertConnectedToTestDatabase(fake("postgres"))).rejects.toThrow(/not a test database/);
  });
});
