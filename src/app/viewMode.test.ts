import { expect, test, vi } from "vitest";
import { resolveViewMode, writeViewMode } from "./viewMode";

test("operator mode is the default and audit query wins over storage", () => {
  expect(resolveViewMode("", null)).toBe("operator");
  expect(resolveViewMode("?view=audit", "operator")).toBe("audit");
  expect(resolveViewMode("?view=operator", "audit")).toBe("operator");
});

test("invalid query and storage values fail back to operator", () => {
  expect(resolveViewMode("?view=system", "admin")).toBe("operator");
});

test("view choice is persisted under one namespaced key", () => {
  const setItem = vi.fn();
  writeViewMode("audit", { setItem });
  expect(setItem).toHaveBeenCalledWith("seo-ops:view-mode", "audit");
});
