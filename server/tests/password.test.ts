import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

describe("password hashing", () => {
  it("verifies the password against a scrypt encoding and rejects wrong or malformed values", async () => {
    const password = "Correct horse battery staple 42!";
    const encoded = await hashPassword(password);

    expect(encoded).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword(password, encoded)).toBe(true);
    expect(await verifyPassword("wrong password", encoded)).toBe(false);
    expect(await verifyPassword("anything", "broken")).toBe(false);
  });

  it("rejects passwords outside the 12 to 128 Unicode-code-point policy", async () => {
    await expect(hashPassword("too-short")).rejects.toThrow();
    await expect(hashPassword("a".repeat(129))).rejects.toThrow();
  });
});
