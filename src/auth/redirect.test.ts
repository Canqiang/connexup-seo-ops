import { expect, test } from "vitest";
import { buildLoginUrl, isLoginPath, safeReturnTo } from "./redirect";

test("builds a same-origin login return path", () => {
  expect(buildLoginUrl("/seo-ops/tasks/task-1?tab=evidence")).toBe(
    "/seo-ops/login?return_to=%2Fseo-ops%2Ftasks%2Ftask-1%3Ftab%3Devidence"
  );
});

test.each([
  ["https://evil.example/x"],
  ["//evil.example/x"],
  ["/seo-ops/login"],
  ["/seo-ops/login?return_to=%2Fseo-ops%2Ftasks"],
  ["/seo-ops/login/"],
  ["/seo-ops/login/next"],
  ["/seo-ops/%2f%2fevil.example/x"],
  ["/seo-ops/%252f%252fevil.example/x"],
  ["/seo-ops/\u0000unsafe"],
  ["/other/path"],
])("rejects unsafe return path %j", (path) => {
  expect(safeReturnTo(path)).toBe("/seo-ops/");
});

test("browser normalization turns an encoded parent segment into an out-of-scope path", () => {
  expect(new URL("/seo-ops/%2e%2e/settings", "https://seo-ops.invalid").pathname).toBe("/settings");
  expect(safeReturnTo("/seo-ops/%2e%2e/settings")).toBe("/seo-ops/");
});

test.each([
  ["literal parent", "/seo-ops/../settings"],
  ["literal current", "/seo-ops/./tasks"],
  ["encoded parent", "/seo-ops/%2e%2e/settings"],
  ["mixed-case double encoding", "/seo-ops/%252E%252e%252Fsettings"],
  ["mixed slash", "/seo-ops/%2e%2e%5csettings"],
  ["query and fragment", "/seo-ops/%2e%2e/settings?tab=evidence#review"],
])("rejects a %s dot-segment escape", (_label, path) => {
  expect(safeReturnTo(path)).toBe("/seo-ops/");
});

test("keeps a same-origin SEO Ops deep link query and fragment", () => {
  expect(safeReturnTo("/seo-ops/tasks/task-1?tab=evidence#review")).toBe("/seo-ops/tasks/task-1?tab=evidence#review");
});

test("recognizes the canonical login route with one trailing slash", () => {
  expect(isLoginPath("/seo-ops/login")).toBe(true);
  expect(isLoginPath("/seo-ops/login/")).toBe(true);
  expect(isLoginPath("/seo-ops/login/next")).toBe(false);
});
