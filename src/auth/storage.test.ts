import { afterEach, expect, test, vi } from "vitest";
import { clearAuthStorage } from "./storage";

afterEach(() => localStorage.clear());

test("clears only legacy identity and favorite keys", () => {
  ["apiKey", "userId", "userName", "userRole", "userPermissions", "seoops.favorite_merchants.operator-1"].forEach((key) => {
    localStorage.setItem(key, "legacy");
  });
  localStorage.setItem("merchant-filter", "keep");

  clearAuthStorage();

  expect(localStorage.getItem("apiKey")).toBeNull();
  expect(localStorage.getItem("userId")).toBeNull();
  expect(localStorage.getItem("userName")).toBeNull();
  expect(localStorage.getItem("userRole")).toBeNull();
  expect(localStorage.getItem("userPermissions")).toBeNull();
  expect(localStorage.getItem("seoops.favorite_merchants.operator-1")).toBeNull();
  expect(localStorage.getItem("merchant-filter")).toBe("keep");
});

test("limits legacy key enumeration and fails soft when storage is unavailable", () => {
  const key = vi.fn(() => null);
  const storage = {
    length: 10_000,
    clear: vi.fn(), getItem: vi.fn(), key, removeItem: vi.fn(), setItem: vi.fn(),
  } as unknown as Storage;
  const unavailable = {
    get length() { throw new Error("storage denied"); },
    clear: vi.fn(), getItem: vi.fn(), key: vi.fn(), removeItem: vi.fn(() => { throw new Error("storage denied"); }), setItem: vi.fn(),
  } as unknown as Storage;

  clearAuthStorage(storage);

  expect(key).toHaveBeenCalledTimes(256);
  expect(() => clearAuthStorage(unavailable)).not.toThrow();
});

test("fails soft when retrieving the browser storage object itself throws", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("storage denied"); } });
  try {
    expect(() => clearAuthStorage()).not.toThrow();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  }
});
