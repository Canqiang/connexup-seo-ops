import { expect, test } from "vitest";
import { buildLoginUrl, safeReturnTo } from "./redirect";

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
  ["/seo-ops/%2f%2fevil.example/x"],
  ["/seo-ops/%252f%252fevil.example/x"],
  ["/seo-ops/\u0000unsafe"],
  ["/other/path"],
])("rejects unsafe return path %j", (path) => {
  expect(safeReturnTo(path)).toBe("/seo-ops/");
});

test("keeps a same-origin SEO Ops route", () => {
  expect(safeReturnTo("/seo-ops/tasks/task-1?tab=evidence")).toBe("/seo-ops/tasks/task-1?tab=evidence");
});
