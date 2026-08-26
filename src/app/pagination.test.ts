import { describe, expect, test } from "vitest";
import { canonicalOffset, pageRecoveryOffset, visiblePageRange } from "./pagination";

describe("canonicalOffset", () => {
  test.each([
    ["", 0, false],
    ["offset=0", 0, false],
    ["offset=50", 50, false],
  ])("accepts a missing or canonical offset: %s", (query, value, needsNormalization) => {
    expect(canonicalOffset(new URLSearchParams(query))).toEqual({ value, needsNormalization });
  });

  test.each([
    "offset=",
    "offset=-1",
    "offset=1e2",
    "offset=0x10",
    "offset=1.5",
    "offset=00",
    "offset=9007199254740992",
    "offset=50&offset=0",
  ])("rejects and normalizes a non-canonical offset: %s", (query) => {
    expect(canonicalOffset(new URLSearchParams(query))).toEqual({ value: 0, needsNormalization: true });
  });
});

test("page helpers derive visible truth from the server page", () => {
  expect(visiblePageRange({ offset: 100, limit: 50, total: 107, items: Array.from({ length: 7 }) })).toEqual({ start: 101, end: 107 });
  expect(pageRecoveryOffset({ offset: 100, limit: 50, total: 51, items: [] })).toBe(50);
  expect(pageRecoveryOffset({ offset: 50, limit: 50, total: 0, items: [] })).toBe(0);
  expect(pageRecoveryOffset({ offset: 0, limit: 50, total: 0, items: [] })).toBeNull();
});
