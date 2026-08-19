import { describe, expect, it } from "vitest";
import {
  canonicalize,
  executionSpecHash,
  requestFingerprint,
  sha256Hash,
} from "../src/domain/hashing.js";

describe("canonicalize", () => {
  it("object key order does not change canonical form", () => {
    const a = canonicalize('{"b":2,"a":1}');
    const b = canonicalize('{"a":1,"b":2}');
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it("array order changes canonical form", () => {
    const a = canonicalize('{"x":[1,2]}');
    const b = canonicalize('{"x":[2,1]}');
    expect(a).not.toBe(b);
  });

  it("sorts nested object keys recursively", () => {
    const out = canonicalize('{"b":{"c":2,"a":1},"a":1}');
    expect(out).toBe('{"a":1,"b":{"a":1,"c":2}}');
  });

  it("exact fixture matches", () => {
    expect(canonicalize('{"b":{"c":2},"a":1}')).toBe('{"a":1,"b":{"c":2}}');
  });

  it("rejects malformed JSON", () => {
    expect(() => canonicalize("{nope")).toThrowError(/valid JSON/);
  });
});

describe("sha256Hash / executionSpecHash", () => {
  it("returns sha256: prefix with 64 lowercase hex", () => {
    const hash = sha256Hash("anything");
    expect(hash.startsWith("sha256:")).toBe(true);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("object key order does not change spec hash", () => {
    expect(executionSpecHash('{"b":2,"a":1}')).toBe(
      executionSpecHash('{"a":1,"b":2}'),
    );
  });

  it("array order changes spec hash", () => {
    const a = executionSpecHash('{"x":[1,2]}');
    const b = executionSpecHash('{"x":[2,1]}');
    expect(a).not.toBe(b);
  });
});

describe("requestFingerprint", () => {
  it("is stable regardless of object key order", () => {
    const a = requestFingerprint({ b: 2, a: 1 });
    const b = requestFingerprint({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    expect(requestFingerprint({ a: 1 })).not.toBe(requestFingerprint({ a: 2 }));
  });
});
