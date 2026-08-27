import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SeoTask, StageRunView } from "../../api/types";
import { taskFixture } from "../../test/fixtures";
import { DraftsPanel } from "./DraftsPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function contentTask(overrides: Partial<SeoTask> = {}): SeoTask {
  return {
    ...taskFixture,
    id: "task-gbp-content",
    title: "Generate this week's GBP Post",
    task_type: "GBP_POST",
    execution_mode: "AUTO_WRITE",
    status: "DRAFT",
    required_evidence_types: ["CONTENT_DRAFT"],
    location_id: "mineola",
    location_name: "Mineola",
    ...overrides,
  };
}

function contentRun(status: StageRunView["status"], overrides: Partial<StageRunView> = {}): StageRunView {
  return {
    id: "run-gbp-content",
    merchant_id: "only-bear",
    location_id: "mineola",
    task_id: "task-gbp-content",
    stage: "GBP_POST_CONTENT",
    run_type: "GBP_POST_CONTENT",
    goal: null,
    status,
    core_run_id: "core-run-gbp-content",
    core_status: status,
    input_message: "{}",
    token_usage: {},
    deliverables: [],
    triggered_by: "user-1",
    triggered_at: "2026-08-27T08:00:00.000Z",
    created_at: "2026-08-27T08:00:00.000Z",
    updated_at: "2026-08-27T08:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("shows Core AI draft generation only for editable AUTO_WRITE GBP_POST tasks", () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [] })));
  const { rerender } = render(<DraftsPanel onReadback={() => undefined} task={contentTask()} />);

  expect(screen.getByRole("button", { name: /Core AI 生成图文草稿/ })).toBeEnabled();
  expect(screen.getByText(/只保存为草稿，不会发布到 Google/)).toBeInTheDocument();

  rerender(<DraftsPanel onReadback={() => undefined} task={contentTask({ execution_mode: "ARTIFACT" })} />);
  expect(screen.queryByRole("button", { name: /Core AI 生成图文草稿/ })).not.toBeInTheDocument();

  rerender(<DraftsPanel onReadback={() => undefined} task={contentTask({ task_type: "WEBSITE_SEO" })} />);
  expect(screen.queryByRole("button", { name: /Core AI 生成图文草稿/ })).not.toBeInTheDocument();

  rerender(<DraftsPanel onReadback={() => undefined} task={contentTask({ status: "APPROVED" })} />);
  expect(screen.queryByRole("button", { name: /Core AI 生成图文草稿/ })).not.toBeInTheDocument();
});

test("submits one UUID-keyed content run, polls it to completion, and refreshes task and drafts", async () => {
  vi.useFakeTimers();
  let resolveTrigger!: (response: Response) => void;
  const triggerResponse = new Promise<Response>((resolve) => { resolveTrigger = resolve; });
  let draftReads = 0;
  const updatedTask = contentTask({ state_version: 6 });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts") && (!init?.method || init.method === "GET")) {
      draftReads += 1;
      return json({ items: [] });
    }
    if (path.endsWith("/content-runs") && init?.method === "POST") return triggerResponse;
    if (path.endsWith("/agent-runs/run-gbp-content")) {
      return json(contentRun("COMPLETED", { completed_at: "2026-08-27T08:02:00.000Z" }));
    }
    if (path.endsWith("/tasks/task-gbp-content")) return json(updatedTask);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onReadback = vi.fn();
  render(<DraftsPanel onReadback={onReadback} task={contentTask()} />);
  const panel = screen.getByRole("region", { name: "内容稿" });
  const button = within(panel).getByRole("button", { name: /Core AI 生成图文草稿/ });

  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(within(panel).getByText(/正在提交生成请求/)).toBeInTheDocument();
  fireEvent.click(button);

  const postCalls = fetchMock.mock.calls.filter(([path, init]) =>
    String(path).endsWith("/content-runs") && init?.method === "POST");
  expect(postCalls).toHaveLength(1);
  const requestBody = JSON.parse(String(postCalls[0]?.[1]?.body));
  expect(requestBody).toEqual({ idempotency_key: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i) });

  await act(async () => {
    resolveTrigger(json(contentRun("TRIGGERING"), 202));
    await Promise.resolve();
  });
  expect(within(panel).getByText(/Core AI 正在生成英文 Post 文案与图片/)).toBeInTheDocument();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
  });

  expect(within(panel).getByText(/图文草稿和图片已生成，尚未发布/)).toBeInTheDocument();
  expect(within(panel).queryByText(/^已发布$/)).not.toBeInTheDocument();
  expect(onReadback).toHaveBeenCalledWith(updatedTask);
  expect(draftReads).toBeGreaterThanOrEqual(2);
});

test("shows a terminal content-run failure without implying a publication", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts")) return json({ items: [] });
    if (path.endsWith("/content-runs") && init?.method === "POST") {
      return json(contentRun("FAILED", {
        error: "Image attachment was missing",
        error_code: "GBP_POST_IMAGE_MISSING",
      }), 202);
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<DraftsPanel onReadback={() => undefined} task={contentTask()} />);

  fireEvent.click(screen.getByRole("button", { name: /Core AI 生成图文草稿/ }));

  expect(await screen.findByRole("alert")).toHaveTextContent("图文草稿生成失败：Image attachment was missing");
  expect(screen.getByRole("button", { name: /图文生成失败/ })).toBeDisabled();
  expect(screen.queryByText(/^已发布$/)).not.toBeInTheDocument();
});
