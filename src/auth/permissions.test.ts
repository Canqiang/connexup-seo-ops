import { expect, test } from "vitest";
import { hasPermission } from "./permissions";

test("honors wildcard and manage-implies-view", () => {
  expect(hasPermission(["*"], "seoops.approve")).toBe(true);
  expect(hasPermission(["seoops.manage"], "seoops.view")).toBe(true);
  expect(hasPermission(["seoops.view"], "seoops.manage")).toBe(false);
});
