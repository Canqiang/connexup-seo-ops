import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { taskFixture } from "../../test/fixtures";
import { ApprovalPanel } from "./ApprovalPanel";

const api = vi.hoisted(() => ({
  approvalPreview: vi.fn(),
  approvalDecision: vi.fn(),
  task: vi.fn(),
}));

vi.mock("../../api/seoOpsApi", () => ({ seoOpsApi: api }));

beforeEach(() => {
  vi.clearAllMocks();
  api.approvalPreview.mockResolvedValue({
    reviewable: true,
    blockers: [],
    task_revision: taskFixture.task_revision,
    state_version: taskFixture.state_version,
    execution_spec_hash: taskFixture.execution_spec_hash,
    evidence_state: taskFixture.evidence_state,
    current_status: taskFixture.status,
  });
  const approved = { ...taskFixture, status: "APPROVED" as const, state_version: taskFixture.state_version + 1 };
  api.approvalDecision.mockResolvedValue(approved);
  api.task.mockResolvedValue(approved);
});

test("approves the current version in one operator action without exposing audit fields", async () => {
  const onReadback = vi.fn();
  render(<ApprovalPanel canApprove onReadback={onReadback} task={taskFixture} />);

  expect(screen.queryByText("执行哈希")).not.toBeInTheDocument();
  expect(screen.queryByText("影响范围")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("拒绝 / 撤销原因")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "批准并进入发布" }));

  expect(api.approvalPreview).toHaveBeenCalledTimes(1);
  expect(api.approvalDecision).toHaveBeenCalledWith(taskFixture.id, expect.objectContaining({
    decision: "APPROVE",
    task_revision: taskFixture.task_revision,
    execution_spec_hash: taskFixture.execution_spec_hash,
  }));
  expect(onReadback).toHaveBeenCalledWith(expect.objectContaining({ status: "APPROVED" }));
});
