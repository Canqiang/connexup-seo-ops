import { expect, test } from "vitest";
import { buildLoginUrl } from "./redirect";

test("builds a same-origin login return path", () => {
  expect(buildLoginUrl("/seo-ops/tasks/task-1?tab=evidence")).toBe(
    "/login?return_to=%2Fseo-ops%2Ftasks%2Ftask-1%3Ftab%3Devidence"
  );
});
