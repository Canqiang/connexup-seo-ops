import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function hasAllowedLength(password: string): boolean {
  const codePoints = Array.from(password).length;
  return codePoints >= 12 && codePoints <= 128;
}

function isCanonicalBase64Url(value: string, size: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === size && decoded.toString("base64url") === value;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: MAX_MEMORY,
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (!hasAllowedLength(password)) {
    throw new Error("password must contain 12 to 128 Unicode code points");
  }
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = await deriveKey(password, salt);
  return [
    "scrypt",
    String(COST),
    String(BLOCK_SIZE),
    String(PARALLELIZATION),
    salt.toString("base64url"),
    derivedKey.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!hasAllowedLength(password)) return false;
  const parts = encoded.split("$");
  if (
    parts.length !== 6
    || parts[0] !== "scrypt"
    || parts[1] !== String(COST)
    || parts[2] !== String(BLOCK_SIZE)
    || parts[3] !== String(PARALLELIZATION)
  ) return false;

  const saltEncoded = parts[4];
  const keyEncoded = parts[5];
  if (!saltEncoded || !keyEncoded || !isCanonicalBase64Url(saltEncoded, SALT_BYTES)
    || !isCanonicalBase64Url(keyEncoded, KEY_BYTES)) return false;

  try {
    const actual = await deriveKey(password, Buffer.from(saltEncoded, "base64url"));
    const expected = Buffer.from(keyEncoded, "base64url");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
