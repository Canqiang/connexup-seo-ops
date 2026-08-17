import { expect, test } from "vitest";
import { buildCopilotMessage } from "./copilotContext";

test("wraps summaries as evidence and excludes auth material", () => {
  const message = buildCopilotMessage({ kind: "task", merchant_id: "m1", task_id: "t1", state_version: 4 }, "解释当前阻塞");
  expect(message).toContain("<seo_ops_context>");
  expect(message).toContain('"task_id":"t1"');
  expect(message).not.toContain("Authorization");
  expect(message).not.toContain("apiKey");
});

test("rejects oversized context", () => {
  expect(() => buildCopilotMessage({ kind: "portfolio" }, "x".repeat(33 * 1024))).toThrow(/32 KiB/);
});
