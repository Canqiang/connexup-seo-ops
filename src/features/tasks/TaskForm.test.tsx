import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { seoOpsApi } from "../../api/seoOpsApi";
import { portfolioFixture, taskFixture } from "../../test/fixtures";
import { TaskForm } from "./TaskForm";

afterEach(() => vi.restoreAllMocks());

function renderForm() {
  return render(
    <MemoryRouter>
      <TaskForm merchants={portfolioFixture.merchants} onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

test("ordinary tasks explicitly submit the MANUAL execution mode", async () => {
  const createTask = vi.spyOn(seoOpsApi, "createTask").mockResolvedValue(taskFixture);
  vi.spyOn(seoOpsApi, "task").mockResolvedValue(taskFixture);
  renderForm();

  await userEvent.type(screen.getByLabelText("任务标题"), "人工检查菜单页");
  expect(screen.getByLabelText("执行模式")).toHaveValue("MANUAL");
  await userEvent.click(screen.getByRole("button", { name: "创建任务" }));

  await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
  expect(createTask.mock.calls[0]?.[0].definition.execution_mode).toBe("MANUAL");
});

test("GBP_POST applies an Agent-ready draft template and keeps publication behind approval", async () => {
  const createTask = vi.spyOn(seoOpsApi, "createTask").mockResolvedValue({
    ...taskFixture,
    task_type: "GBP_POST",
    execution_mode: "AUTO_WRITE",
  });
  vi.spyOn(seoOpsApi, "task").mockResolvedValue({
    ...taskFixture,
    task_type: "GBP_POST",
    execution_mode: "AUTO_WRITE",
  });
  renderForm();

  fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "GBP_POST" } });

  expect(screen.getByLabelText("执行模式")).toHaveValue("AUTO_WRITE");
  expect(screen.getByLabelText(/地点/)).toBeRequired();
  expect(screen.getByLabelText(/证据要求/)).toHaveValue("CONTENT_DRAFT");
  expect(screen.getByText(/先生成图文草稿/)).toBeInTheDocument();
  expect(screen.getByText(/不会在创建时立即发布/)).toBeInTheDocument();

  const spec = JSON.parse((screen.getByLabelText("执行规范 JSON") as HTMLTextAreaElement).value) as Record<string, unknown>;
  expect(spec).toMatchObject({
    post_type: "STANDARD",
    primary_keyword_cluster: {
      cluster_id: "operator-local-discovery",
      search_intent: "local restaurant discovery",
      keywords: ["restaurant near me"],
    },
    evidence_references: ["operator:manual-task-form"],
  });
  expect(spec.occurrence_at).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/));

  await userEvent.type(screen.getByLabelText("任务标题"), "本周 GBP Post");
  await userEvent.selectOptions(screen.getByLabelText(/地点/), "mineola");
  await userEvent.click(screen.getByRole("button", { name: "创建任务" }));

  await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
  expect(createTask.mock.calls[0]?.[0]).toMatchObject({
    merchant_id: "only-bear",
    location_id: "mineola",
    definition: {
      task_type: "GBP_POST",
      execution_mode: "AUTO_WRITE",
      required_evidence_types: ["CONTENT_DRAFT"],
    },
  });
});

test("GBP_POST cannot be submitted without an exact location", () => {
  const createTask = vi.spyOn(seoOpsApi, "createTask").mockResolvedValue(taskFixture);
  renderForm();

  fireEvent.change(screen.getByLabelText("任务类型"), { target: { value: "GBP_POST" } });
  fireEvent.change(screen.getByLabelText("任务标题"), { target: { value: "本周 GBP Post" } });
  fireEvent.submit(screen.getByRole("button", { name: "创建任务" }).closest("form")!);

  expect(createTask).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("GBP Post 必须选择一个具体地点");
});
