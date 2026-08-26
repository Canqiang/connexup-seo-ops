import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import type { AttemptWire } from "../../api/types";
import { ReconciliationDialog } from "./ReconciliationDialog";

const unknownAttempt: AttemptWire = {
  id: "attempt-1", task_id: "task-1", merchant_id: "merchant-1", attempt_no: 3,
  status: "OUTCOME_UNKNOWN", gate: "G2", agent_run_id: "agent-run-1", core_run_id: "core-run-1",
  probe_ref: "probe-1", error: "confirmation timed out", started_at: "2026-08-26T08:00:00Z",
  resolved_at: null, resolved_by: null, resolution: null, resolution_note: null,
};

test("unknown outcome offers two equal human conclusions and no retry", () => {
  render(<ReconciliationDialog attempt={unknownAttempt} onClose={vi.fn()} onResolved={vi.fn()} />);

  expect(screen.getByRole("button", { name: "确认未发生，可重新排队" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认已发生，进入核验" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /自动重试|立即重试/ })).not.toBeInTheDocument();
});

test("unknown outcome requires evidence and a selected conclusion before submission", async () => {
  const user = userEvent.setup();
  const onResolved = vi.fn();
  render(<ReconciliationDialog attempt={unknownAttempt} onClose={vi.fn()} onResolved={onResolved} />);

  const submit = screen.getByRole("button", { name: "提交查证结论" });
  expect(submit).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "确认未发生，可重新排队" }));
  expect(submit).toBeDisabled();
  await user.type(screen.getByLabelText("查证依据（必填）"), "GBP 后台未见对应帖子");
  expect(submit).toBeEnabled();
});
