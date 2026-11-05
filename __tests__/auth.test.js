const auth = require("../auth");

beforeAll(() => {
  process.env.SESSION_SECRET = "unit-test-secret";
});

describe("passwords", () => {
  test("hashes with scrypt and a random salt", () => {
    const a = auth.hashPassword("ali123");
    const b = auth.hashPassword("ali123");

    expect(a).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(a).not.toBe(b);
  });

  test("verifies hashed passwords", () => {
    const stored = auth.hashPassword("ali123");

    expect(auth.verifyPassword("ali123", stored)).toBe(true);
    expect(auth.verifyPassword("ali124", stored)).toBe(false);
  });

  test("still accepts legacy plaintext passwords so they can be upgraded", () => {
    expect(auth.verifyPassword("ali123", "ali123")).toBe(true);
    expect(auth.verifyPassword("nope", "ali123")).toBe(false);
    expect(auth.isHashed("ali123")).toBe(false);
  });

  test.each([[undefined, "x"], ["x", undefined], ["", ""], [123, "123"]])("rejects bad input %p / %p", (pw, stored) => {
    expect(auth.verifyPassword(pw, stored)).toBe(false);
  });
});

describe("session tokens", () => {
  test("round-trip user id and role", () => {
    expect(auth.readSessionToken(auth.createSessionToken("ali", "user"))).toEqual({ userId: "ali", role: "user" });
    expect(auth.readSessionToken(auth.createSessionToken("admin", "admin"))).toEqual({ userId: "admin", role: "admin" });
  });

  test("expire after 7 days", () => {
    const issued = Date.now();
    const token = auth.createSessionToken("ali", "user", issued);

    expect(auth.readSessionToken(token, issued + 6 * 86400000)).not.toBeNull();
    expect(auth.readSessionToken(token, issued + 8 * 86400000)).toBeNull();
  });

  test("reject a changed payload (privilege escalation)", () => {
    const [, sig] = auth.createSessionToken("ali", "user").split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "ali", role: "admin", exp: Date.now() + 1e9 })).toString("base64url");

    expect(auth.readSessionToken(`${forged}.${sig}`)).toBeNull();
  });

  test("reject tokens signed with another secret", () => {
    const token = auth.createSessionToken("ali", "user");
    process.env.SESSION_SECRET = "other-secret";
    try {
      expect(auth.readSessionToken(token)).toBeNull();
    } finally {
      process.env.SESSION_SECRET = "unit-test-secret";
    }
  });

  test.each([[null], [""], ["abc"], ["a.b.c"], ["%%%.x"]])("reject malformed token %p", (token) => {
    expect(auth.readSessionToken(token)).toBeNull();
  });

  test("refuse to run in production without SESSION_SECRET", () => {
    const { SESSION_SECRET, NODE_ENV } = process.env;
    delete process.env.SESSION_SECRET;
    process.env.NODE_ENV = "production";
    try {
      expect(() => auth.createSessionToken("ali", "user")).toThrow("SESSION_SECRET");
    } finally {
      process.env.SESSION_SECRET = SESSION_SECRET;
      process.env.NODE_ENV = NODE_ENV;
    }
  });
});
