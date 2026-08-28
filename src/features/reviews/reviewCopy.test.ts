import { expect, test } from "vitest";
import { classificationLabel, reviewExplanation, tierLabel } from "./reviewCopy";

test("does not overclaim causality", () => {
  expect(reviewExplanation("INSUFFICIENT_EVIDENCE")).toContain("证据不足，无法判断因果");
  expect(reviewExplanation("CORRELATIONAL")).toContain("时间相关");
  expect(reviewExplanation("CORRELATIONAL")).not.toContain("提升了");
});

test("classification labels never promote a correlational reading to causal", () => {
  expect(classificationLabel("CORRELATIONAL")).toBe("关联（上限 ASSOCIATIONAL）");
  expect(classificationLabel("CAUSAL_READY")).toBe("因果设计就绪（需单独批准）");
  expect(tierLabel("ASSOCIATIONAL")).toBe("正向/负向关联 · ASSOCIATIONAL");
  expect(tierLabel("INSUFFICIENT_EVIDENCE")).toBe("无法定论 · INSUFFICIENT");
});
