import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AgentRunsPanel } from "./AgentRunsPanel";
import {
  agentRunCompletedFixture,
  agentRunRunningFixture,
} from "../../test/fixtures";

interface Call { path: string; init?: RequestInit }

function stubFetch(handler: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input), init };
    calls.push(call);
    const body = handler(call);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
  return calls;
}

const enabledConfig = { copilot_enabled: false, agent_run_enabled: true, agent_run_types: ["AUDIT", "PLAN"] };
const emptyPage = { items: [], offset: 0, limit: 50, total: 0 };

beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-0000-0000-000000000000");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("trigger button is disabled when agent runs are not enabled", async () => {
  stubFetch((call) => {
    if (call.path === "/api/seo-ops/config") return { copilot_enabled: false };
    return emptyPage;
  });
  render(<AgentRunsPanel canManage taskId="task-1" onTaskChanged={() => {}} />);
  const button = await screen.findByRole("button", { name: "触发 Agent Run" });
  expect(button).toBeDisabled();
  expect(screen.getByText(/只读 SOP 运行未启用/)).toBeInTheDocument();
});

test("trigger posts the expected body and shows the RUNNING run", async () => {
  const calls = stubFetch((call) => {
    if (call.path === "/api/seo-ops/config") return enabledConfig;
    if (call.path === "/api/seo-ops/tasks/task-1/agent-runs" && call.init?.method === "POST") {
      return agentRunRunningFixture;
    }
    return { ...emptyPage, items: [agentRunRunningFixture], total: 1 };
  });
  const user = userEvent.setup();
  render(<AgentRunsPanel canManage taskId="task-1" onTaskChanged={() => {}} />);

  await screen.findByRole("button", { name: "触发 Agent Run" });
  await user.type(screen.getByLabelText("操作员补充目标（可选）"), "  关注 SoLV  ");
  await user.click(screen.getByRole("button", { name: "触发 Agent Run" }));

  const post = calls.find((call) => call.path === "/api/seo-ops/tasks/task-1/agent-runs" && call.init?.method === "POST");
  expect(post).toBeDefined();
  expect(JSON.parse(String(post?.init?.body))).toEqual({
    run_type: "AUDIT",
    goal: "关注 SoLV",
    idempotency_key: "00000000-0000-0000-0000-000000000000",
  });
  expect(await screen.findByText("RUNNING", { selector: ".status-pill" })).toBeInTheDocument();
});

test("cancel is only offered for active runs", async () => {
  stubFetch((call) => {
    if (call.path === "/api/seo-ops/config") return enabledConfig;
    return { ...emptyPage, items: [agentRunCompletedFixture, agentRunRunningFixture], total: 2 };
  });
  render(<AgentRunsPanel canManage taskId="task-1" onTaskChanged={() => {}} />);
  expect(await screen.findAllByRole("button", { name: "取消" })).toHaveLength(1);
});

test("completed run expands its output", async () => {
  stubFetch((call) => {
    if (call.path === "/api/seo-ops/config") return enabledConfig;
    return { ...emptyPage, items: [agentRunCompletedFixture], total: 1 };
  });
  const user = userEvent.setup();
  render(<AgentRunsPanel canManage taskId="task-1" onTaskChanged={() => {}} />);
  await user.click(await screen.findByText(/查看输出/));
  expect(screen.getByText(/结论先行：优先补齐经营类别/)).toBeInTheDocument();
});

test("polls every 5s while a run is active and fires onTaskChanged at terminal", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let runs = [agentRunRunningFixture];
  const calls = stubFetch((call) => {
    if (call.path === "/api/seo-ops/config") return enabledConfig;
    return { ...emptyPage, items: runs, total: runs.length };
  });
  const onTaskChanged = vi.fn();
  render(<AgentRunsPanel canManage taskId="task-1" onTaskChanged={onTaskChanged} />);
  await screen.findByText("RUNNING", { selector: ".status-pill" });
  const listCalls = () =>
    calls.filter((call) => call.path.startsWith("/api/seo-ops/tasks/task-1/agent-runs") && call.init?.method !== "POST").length;
  const listCallsBefore = listCalls();

  await act(async () => { vi.advanceTimersByTime(5000); });
  const listCallsAfter = listCalls();
  expect(listCallsAfter).toBeGreaterThan(listCallsBefore);
  expect(onTaskChanged).not.toHaveBeenCalled();

  runs = [agentRunCompletedFixture];
  await act(async () => { vi.advanceTimersByTime(5000); });
  await waitFor(() => expect(onTaskChanged).toHaveBeenCalledTimes(1));
});

test("surfaces a 503 as a readable message", async () => {
  stubFetch((call) => {
    if (call.path === "/api/seo-ops/config") return enabledConfig;
    if (call.path === "/api/seo-ops/tasks/task-1/agent-runs" && call.init?.method === "POST") {
      return new Response(JSON.stringify({ message: "core-ai is not configured", error_code: "CORE_AI_NOT_CONFIGURED" }), { status: 503 });
    }
    return emptyPage;
  });
  const user = userEvent.setup();
  render(<AgentRunsPanel canManage taskId="task-1" onTaskChanged={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "触发 Agent Run" }));
  expect(await screen.findByText(/后端未配置 core-ai/)).toBeInTheDocument();
});
