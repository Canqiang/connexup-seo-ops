import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { taskFixture } from "../../test/fixtures";
import { GbpWorkflowRail } from "./GbpWorkflowRail";

test("shows the five-step GBP Post operating path and the current approval step", () => {
  render(<GbpWorkflowRail directPublish hasDraft task={{
    ...taskFixture,
    task_type: "GBP_POST",
    execution_mode: "AUTO_WRITE",
    status: "READY_FOR_APPROVAL",
    evidence_refs: [{
      id: "evidence-final", type: "CONTENT_DRAFT",
      source_ref: "draft:task:v1", sha256: "a".repeat(64), captured_at: "2026-08-27T08:00:00Z",
      verification_status: "VERIFIED", requirement_key: "CONTENT_DRAFT", task_revision: taskFixture.task_revision,
      created_by: "user-1", created_at: "2026-08-27T08:00:00Z",
    }],
  }} />);

  expect(screen.getByRole("list", { name: "GBP Post 发布流程" })).toBeInTheDocument();
  expect(screen.getByText("生成图文").closest("li")).toHaveAttribute("data-state", "done");
  expect(screen.getByText("修改与定稿").closest("li")).toHaveAttribute("data-state", "done");
  expect(screen.getByText("人工批准").closest("li")).toHaveAttribute("data-state", "current");
  expect(screen.getByText("发布").closest("li")).toHaveAttribute("data-state", "pending");
  expect(screen.getByText("生效核对").closest("li")).toHaveAttribute("data-state", "pending");
  expect(screen.getByText("GBP 已授权 · 可直接发布")).toBeVisible();
});

test("a published post shows 发布 done and 生效核对 current — publish never implies verified", () => {
  render(<GbpWorkflowRail hasDraft task={{ ...taskFixture, task_type: "GBP_POST", execution_mode: "AUTO_WRITE", status: "PENDING_VERIFY", evidence_refs: [] }} />);
  expect(screen.getByText("发布").closest("li")).toHaveAttribute("data-state", "done");
  expect(screen.getByText("生效核对").closest("li")).toHaveAttribute("data-state", "current");
});
