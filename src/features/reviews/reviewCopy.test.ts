import { expect, test } from "vitest";
import { reviewExplanation } from "./reviewCopy";

test("does not overclaim causality", () => {
  expect(reviewExplanation("INSUFFICIENT_EVIDENCE")).toContain("证据不足，无法判断因果");
  expect(reviewExplanation("CORRELATIONAL")).toContain("时间相关");
  expect(reviewExplanation("CORRELATIONAL")).not.toContain("提升了");
});
