import { createHash } from "node:crypto";

/** Error thrown when the execution spec (or any canonicalize input) is not valid JSON. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/** Recursively sort object keys while preserving array order. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonicalize a raw JSON string: parse, recursively sort object keys, then
 * re-stringify compactly. Throws CanonicalizationError on invalid JSON.
 */
export function canonicalize(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CanonicalizationError(
      "value must be valid JSON for canonicalization",
    );
  }
  return JSON.stringify(sortValue(parsed));
}

/** sha256:<64 lowercase hex> over UTF-8 bytes of `input`. */
export function sha256Hash(input: string): string {
  return "sha256:" + createHash("sha256").update(input, "utf8").digest("hex");
}

/** Canonicalize then hash an execution spec. */
export function executionSpecHash(rawSpec: string): string {
  return sha256Hash(canonicalize(rawSpec));
}

/**
 * Fingerprint of an already-parsed request body: canonical JSON (sorted keys,
 * arrays preserved) hashed. Used to distinguish idempotent replay from a
 * conflicting reuse of the same idempotency key.
 */
export function requestFingerprint(body: unknown): string {
  return sha256Hash(JSON.stringify(sortValue(body)));
}
