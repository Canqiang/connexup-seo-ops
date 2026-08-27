import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    execution_spec: JSON.stringify({
      occurrence_at: "2026-08-28T16:00:00.000-04:00",
      post_type: "STANDARD",
      primary_keyword_cluster: {
        cluster_id: "hakka-near-broadway",
        search_intent: "local dining",
        keywords: ["hakka food near broadway"],
      },
      evidence_references: ["keyword-set:v1"],
    }),
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

test("shows Core AI draft generation only for editable AUTO_WRITE GBP_POST tasks", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ items: [] })));
  const { rerender } = render(<DraftsPanel onReadback={() => undefined} task={contentTask()} />);

  expect(screen.getByRole("button", { name: /读取草稿/ })).toBeDisabled();
  expect(await screen.findByRole("button", { name: /Core AI 生成图文草稿/ })).toBeEnabled();
  expect(screen.getByText(/批准前都不会发布/)).toBeInTheDocument();

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
    if (path.includes("/merchants/only-bear/stage-runs?")) return json({ items: [], offset: 0, limit: 50, total: 0 });
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
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const button = within(panel).getByRole("button", { name: /Core AI 生成图文草稿/ });

  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(within(panel).getByText(/正在提交生成请求/)).toBeInTheDocument();
  fireEvent.click(button);

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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

test("regenerates from an existing draft with explicit completed-run lineage and no task revision", async () => {
  const generatedDraft = {
    id: "draft-1", task_id: "task-gbp-content", agent_run_id: "run-gbp-content-v1",
    media_source_agent_run_id: null, version: 1, body: "Existing v1 copy", cta_type: "NONE", cta_url: null,
    media: [], media_previews: [], source: "AGENT_GENERATED", feedback: null,
    sha256: "a".repeat(64), created_by: "agent", created_at: "2026-08-27T08:00:00.000Z",
  };
  const currentTask = contentTask({ state_version: 6 });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts") && (!init?.method || init.method === "GET")) {
      return json({ items: [generatedDraft] });
    }
    if (path.includes("/merchants/only-bear/stage-runs?")) {
      return json({
        items: [contentRun("COMPLETED", { id: "run-gbp-content-v1" })],
        offset: 0, limit: 50, total: 1,
      });
    }
    if (path.endsWith("/content-runs") && init?.method === "POST") {
      return json(contentRun("COMPLETED", { id: "run-gbp-content-v2" }), 201);
    }
    if (path.endsWith("/tasks/task-gbp-content")) return json(currentTask);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onReadback = vi.fn();
  render(<DraftsPanel onReadback={onReadback} task={contentTask()} />);

  const regenerate = await screen.findByRole("button", { name: /重新生成/ });
  expect(regenerate).toBeEnabled();
  fireEvent.click(regenerate);

  await waitFor(() => expect(fetchMock.mock.calls.some(([path, init]) =>
    String(path).endsWith("/content-runs") && init?.method === "POST")).toBe(true));
  const generationCallIndex = fetchMock.mock.calls.findIndex(([path, init]) =>
    String(path).endsWith("/content-runs") && init?.method === "POST");
  expect(fetchMock.mock.calls.some(([path, init]) =>
    String(path).endsWith("/tasks/task-gbp-content/revisions") && init?.method === "POST")).toBe(false);
  const generationPayload = JSON.parse(String(fetchMock.mock.calls[generationCallIndex]?.[1]?.body));
  expect(generationPayload).toMatchObject({
    idempotency_key: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i),
    retry: {
      prior_run_id: "run-gbp-content-v1",
      mode: "REGENERATE",
      reason: expect.stringContaining("重新生成"),
    },
  });
  expect(screen.getByText("Existing v1 copy")).toBeInTheDocument();
  await waitFor(() => expect(onReadback).toHaveBeenCalledWith(currentTask));
  expect(screen.getByRole("button", { name: /重新生成/ })).toBeEnabled();
});

test("resumes an active content run instead of branching another regeneration", async () => {
  const generatedDraft = {
    id: "draft-1", task_id: "task-gbp-content", agent_run_id: "run-gbp-content-v1",
    media_source_agent_run_id: null, version: 1, body: "Existing v1 copy", cta_type: "NONE", cta_url: null,
    media: [], media_previews: [], source: "AGENT_GENERATED", feedback: null,
    sha256: "a".repeat(64), created_by: "agent", created_at: "2026-08-27T08:00:00.000Z",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts")) return json({ items: [generatedDraft] });
    if (path.includes("/merchants/only-bear/stage-runs?")) {
      return json({
        items: [contentRun("RUNNING", { id: "run-gbp-content-v2" })],
        offset: 0, limit: 50, total: 1,
      });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<DraftsPanel onReadback={() => undefined} task={contentTask()} />);

  fireEvent.click(await screen.findByRole("button", { name: /重新生成/ }));
  expect(await screen.findByText(/Core AI 正在生成英文 Post 文案与图片/)).toBeInTheDocument();
  expect(fetchMock.mock.calls.some(([path, init]) =>
    String(path).endsWith("/content-runs") && init?.method === "POST")).toBe(false);
});

test("starts a fresh current-input generation when an older draft has a different business fingerprint", async () => {
  const generatedDraft = {
    id: "draft-1", task_id: "task-gbp-content", agent_run_id: "run-old-fingerprint",
    media_source_agent_run_id: null, version: 1, body: "Existing v1 copy", cta_type: "NONE", cta_url: null,
    media: [], media_previews: [], source: "AGENT_GENERATED", feedback: null,
    sha256: "a".repeat(64), created_by: "agent", created_at: "2026-08-27T08:00:00.000Z",
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts")) return json({ items: [generatedDraft] });
    if (path.includes("/merchants/only-bear/stage-runs?")) {
      return json({
        items: [contentRun("COMPLETED", { id: "run-old-fingerprint" })],
        offset: 0, limit: 50, total: 1,
      });
    }
    if (path.endsWith("/content-runs") && init?.method === "POST") {
      const request = JSON.parse(String(init.body));
      if (request.retry) {
        return json({
          message: "retry prior run does not share the current business input fingerprint",
          error_code: "CONTENT_RUN_RETRY_LINEAGE_MISMATCH",
        }, 409);
      }
      return json(contentRun("COMPLETED", { id: "run-current-fingerprint" }), 202);
    }
    if (path.endsWith("/tasks/task-gbp-content")) return json(contentTask({ state_version: 6 }));
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<DraftsPanel onReadback={() => undefined} task={contentTask()} />);

  fireEvent.click(await screen.findByRole("button", { name: /重新生成/ }));
  await screen.findByText(/图文草稿和图片已生成，尚未发布/);
  const generationCalls = fetchMock.mock.calls.filter(([path, init]) =>
    String(path).endsWith("/content-runs") && init?.method === "POST");
  expect(generationCalls).toHaveLength(2);
  expect(JSON.parse(String(generationCalls[0]?.[1]?.body)).retry.mode).toBe("REGENERATE");
  expect(JSON.parse(String(generationCalls[1]?.[1]?.body))).not.toHaveProperty("retry");
});

test("revokes an approved final and opens a clean revision before allowing more edits", async () => {
  const generatedDraft = {
    id: "draft-1", task_id: "task-gbp-content", agent_run_id: "run-gbp-content-v1",
    media_source_agent_run_id: null, version: 1, body: "Approved copy", cta_type: "NONE", cta_url: null,
    media: [], media_previews: [], source: "AGENT_GENERATED", feedback: null,
    sha256: "a".repeat(64), created_by: "agent", created_at: "2026-08-27T08:00:00.000Z",
  };
  const approvedTask = contentTask({
    status: "APPROVED",
    execution_spec: JSON.stringify({
      occurrence_at: "2026-08-28T16:00:00.000-04:00",
      post_type: "STANDARD",
      primary_keyword_cluster: {
        cluster_id: "hakka-near-broadway",
        search_intent: "local dining",
        keywords: ["hakka food near broadway"],
      },
      evidence_references: ["keyword-set:v1"],
      regeneration_request: { request_id: "legacy-request" },
      content_draft: { draft_version: 1, draft_sha256: "a".repeat(64) },
    }),
  });
  const revokedTask = { ...approvedTask, status: "APPROVAL_REVOKED" as const, state_version: 6 };
  const reopenedTask = {
    ...revokedTask,
    status: "NEEDS_INPUT" as const,
    task_revision: 3,
    state_version: 7,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts")) return json({ items: [generatedDraft] });
    if (path.endsWith("/approval-decisions") && init?.method === "POST") return json(revokedTask, 201);
    if (path.endsWith("/revisions") && init?.method === "POST") return json(reopenedTask, 201);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onReadback = vi.fn();
  render(<DraftsPanel onReadback={onReadback} task={approvedTask} />);

  expect(screen.queryByRole("button", { name: /修改文案/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "撤销批准并继续修改" }));
  await waitFor(() => expect(onReadback).toHaveBeenCalledWith(reopenedTask));

  const revokeCallIndex = fetchMock.mock.calls.findIndex(([path, init]) =>
    String(path).endsWith("/approval-decisions") && init?.method === "POST");
  const revisionCallIndex = fetchMock.mock.calls.findIndex(([path, init]) =>
    String(path).endsWith("/revisions") && init?.method === "POST");
  expect(revisionCallIndex).toBeGreaterThan(revokeCallIndex);
  const revokePayload = JSON.parse(String(fetchMock.mock.calls[revokeCallIndex]?.[1]?.body));
  expect(revokePayload).toMatchObject({ decision: "REVOKE", task_revision: 2, expected_state_version: 5 });
  const revisionPayload = JSON.parse(String(fetchMock.mock.calls[revisionCallIndex]?.[1]?.body));
  const reopenedSpec = JSON.parse(revisionPayload.definition.execution_spec);
  expect(revisionPayload.expected_state_version).toBe(6);
  expect(reopenedSpec).not.toHaveProperty("content_draft");
  expect(reopenedSpec).not.toHaveProperty("regeneration_request");
  expect(screen.getByRole("status")).toHaveTextContent("已撤销批准并打开新版本");
});

test("reopens a finalized but unapproved draft without creating an approval decision", async () => {
  const generatedDraft = {
    id: "draft-1", task_id: "task-gbp-content", agent_run_id: "run-gbp-content-v1",
    media_source_agent_run_id: null, version: 1, body: "Final copy", cta_type: "NONE", cta_url: null,
    media: [], media_previews: [], source: "AGENT_GENERATED", feedback: null,
    sha256: "a".repeat(64), created_by: "agent", created_at: "2026-08-27T08:00:00.000Z",
  };
  const finalizedTask = contentTask({
    status: "READY_FOR_APPROVAL",
    execution_spec: JSON.stringify({
      occurrence_at: "2026-08-28T16:00:00.000-04:00",
      post_type: "STANDARD",
      primary_keyword_cluster: {
        cluster_id: "hakka-near-broadway",
        search_intent: "local dining",
        keywords: ["hakka food near broadway"],
      },
      evidence_references: ["keyword-set:v1"],
      content_draft: { draft_version: 1, draft_sha256: "a".repeat(64) },
    }),
  });
  const reopenedTask = {
    ...finalizedTask,
    status: "NEEDS_INPUT" as const,
    task_revision: 3,
    state_version: 6,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts")) return json({ items: [generatedDraft] });
    if (path.endsWith("/revisions") && init?.method === "POST") return json(reopenedTask, 201);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onReadback = vi.fn();
  render(<DraftsPanel onReadback={onReadback} task={finalizedTask} />);

  fireEvent.click(screen.getByRole("button", { name: "撤销定稿并继续修改" }));
  await waitFor(() => expect(onReadback).toHaveBeenCalledWith(reopenedTask));

  expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith("/approval-decisions"))).toBe(false);
  expect(screen.getByRole("status")).toHaveTextContent("已撤销定稿并打开新版本");
});

test("shows a terminal content-run failure without implying a publication", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts")) return json({ items: [] });
    if (path.includes("/merchants/only-bear/stage-runs?")) return json({ items: [], offset: 0, limit: 50, total: 0 });
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

  fireEvent.click(await screen.findByRole("button", { name: /Core AI 生成图文草稿/ }));

  expect(await screen.findByRole("alert")).toHaveTextContent("图片没有完整生成，系统已阻止保存。请重新生成。");
  expect(screen.getByRole("button", { name: /重试生成图文/ })).toBeEnabled();
  expect(screen.queryByText(/^已发布$/)).not.toBeInTheDocument();
});

test("uploads an operator image and saves one human revision with the selected media", async () => {
  const generatedDraft = {
    id: "draft-1", task_id: "task-gbp-content", agent_run_id: "run-gbp-content",
    media_source_agent_run_id: null, version: 1, body: "Agent copy", cta_type: "NONE", cta_url: null,
    media: ["old-media"], media_previews: [], source: "AGENT_GENERATED", feedback: null,
    sha256: "a".repeat(64), created_by: "agent", created_at: "2026-08-27T08:00:00.000Z",
  };
  const uploadedSha = `sha256:${"b".repeat(64)}`;
  const updatedTask = contentTask({ state_version: 2, task_revision: 2 });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/drafts") && (!init?.method || init.method === "GET")) return json({ items: [generatedDraft] });
    if (path.endsWith("/agent-runs/run-gbp-content/deliverables") && init?.method === "POST") {
      return json({
        id: "manual-image", kind: "MANUAL", file_name: "lunch.png", content_type: "image/png",
        size: 8, title: null, description: null, sha256: uploadedSha, downloaded: true,
        download_path: "/api/seo-ops/deliverables/manual-image/download", created_at: "2026-08-27T08:05:00.000Z",
      }, 201);
    }
    if (path.endsWith("/draft-revisions") && init?.method === "POST") return json(updatedTask, 201);
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const onReadback = vi.fn();
  render(<DraftsPanel onReadback={onReadback} task={contentTask()} />);

  fireEvent.click(await screen.findByRole("button", { name: /修改文案|人工新稿/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Post 正文" }), { target: { value: "Operator adjusted copy" } });
  fireEvent.change(screen.getByRole("textbox", { name: "图片说明" }), { target: { value: "Lunch at Choice Brooklyn UWS" } });
  const file = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], "lunch.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText("替换图片"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

  await waitFor(() => expect(onReadback).toHaveBeenCalledWith(updatedTask));
  const revisionCall = fetchMock.mock.calls.find(([path, init]) =>
    String(path).endsWith("/draft-revisions") && init?.method === "POST");
  const payload = JSON.parse(String(revisionCall?.[1]?.body));
  expect(payload).toMatchObject({ body: "Operator adjusted copy", cta_type: "NONE", source: "HUMAN_EDIT" });
  expect(JSON.parse(payload.media[0])).toEqual({
    alt_text: "Lunch at Choice Brooklyn UWS",
    deliverable_id: "manual-image",
    schema_version: "seo_ops.media_ref.v1",
    sha256: uploadedSha,
  });
});
