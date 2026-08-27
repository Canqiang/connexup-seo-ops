import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { GbpExecutionWire, SeoTaskStatus } from "../../api/types";
import { taskFixture } from "../../test/fixtures";
import { ExecutionPanel } from "./ExecutionPanel";
import { GbpExecutionPanel } from "./GbpExecutionPanel";

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const task = {
  ...taskFixture,
  id: "task-gbp",
  merchant_id: "merchant-george",
  merchant_name: "George Restaurant",
  location_id: "location-midtown",
  location_name: "George Midtown",
  task_type: "GBP_POST",
  execution_mode: "AUTO_WRITE" as const,
  status: "EXECUTION_CONFIRMED" as const,
  task_revision: 2,
  execution_spec_hash: sha("a"),
};

function commandView(overrides: Partial<GbpExecutionWire> = {}): GbpExecutionWire {
  return {
    task_id: task.id,
    available: true,
    store: {
      merchant_name: "George Restaurant",
      location_name: "George Midtown",
      account_resource: "accounts/123456789",
      location_resource: "locations/987654321",
      timezone: "America/New_York",
    },
    schedule: { utc: "2026-08-28T15:30:00.000Z", local: "2026-08-28T11:30:00-04:00" },
    approved: {
      body: "Fresh lunch specials are ready.",
      cta: { type: "ORDER", url: "https://example.test/order" },
      image: {
        deliverable_id: "image-local-1", sha256: sha("c"),
        alt_text: "George lunch special",
        download_path: "/api/seo-ops/deliverables/image-local-1/download",
      },
    },
    hashes: {
      command: sha("d"), execution_spec: sha("a"), draft: sha("b"),
      body: sha("e"), cta: sha("f"), image: sha("1"),
    },
    task_revision: 2,
    draft_version: 1,
    command_state: {
      status: "SCHEDULED", state_version: 1,
      scheduled_for: "2026-08-28T15:30:00.000Z", safe_error_code: null,
      trigger_started_at: null, updated_at: "2026-08-27T12:00:00.000Z",
    },
    receipt: null,
    readbacks: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("shows only the immutable GBP command, exact store schedule local image and hashes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(commandView())));

  render(<GbpExecutionPanel canExecute onReadback={() => undefined} task={task} />);
  const panel = await screen.findByRole("region", { name: "GBP 执行" });
  for (const value of [
    "George Restaurant", "George Midtown", "accounts/123456789", "locations/987654321",
    "2026-08-28T15:30:00.000Z", "2026-08-28T11:30:00-04:00",
    "Fresh lunch specials are ready.", "ORDER", "SCHEDULED", sha("a"), sha("b"), sha("c"), sha("d"),
  ]) expect(panel).toHaveTextContent(value);
  expect(within(panel).getByRole("img", { name: "George lunch special" })).toHaveAttribute(
    "src", "/api/seo-ops/deliverables/image-local-1/download",
  );
  expect(within(panel).getByRole("link", { name: /ORDER/ })).toHaveAttribute("href", "https://example.test/order");
  expect(panel).not.toHaveTextContent(/core\.invalid|provider_url|Bearer|secret_ref/i);
});

test("disables confirmation and names every missing exact binding field", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({
    task_id: task.id,
    available: false,
    binding: {
      merchant_id: task.merchant_id,
      location_id: task.location_id,
      status: "MISSING",
      state_version: 0,
      ready_for_gate2: false,
      missing_fields: ["account_resource", "location_resource", "write_agent_published_ref", "readback_agent_published_ref"],
    },
  })));

  render(<GbpExecutionPanel canExecute onReadback={() => undefined} task={{ ...task, status: "APPROVED" }} />);
  const panel = await screen.findByRole("region", { name: "GBP 执行" });
  expect(within(panel).getByRole("button", { name: /确认并冻结/ })).toBeDisabled();
  for (const missing of ["account_resource", "location_resource", "write_agent_published_ref", "readback_agent_published_ref"]) {
    expect(panel).toHaveTextContent(missing);
  }
  expect(panel).toHaveTextContent("旧 GBP_WRITE / 全局 GBP_EXECUTION 不能替代精确地点绑定");
});

test("distinguishes loading and read failure from a disabled Gate 2", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
  const loading = render(<GbpExecutionPanel canExecute onReadback={() => undefined} task={task} />);
  const loadingPanel = screen.getByRole("region", { name: "GBP 执行" });
  expect(within(loadingPanel).getByRole("status")).toHaveTextContent("读取精确 GBP 执行快照");
  expect(loadingPanel).toHaveTextContent("载入中");
  expect(loadingPanel).not.toHaveTextContent("Gate2 已禁用");
  loading.unmount();

  vi.stubGlobal("fetch", vi.fn(async () => json({ message: "unavailable" }, 500)));
  render(<GbpExecutionPanel canExecute onReadback={() => undefined} task={task} />);
  const alert = await screen.findByRole("alert");
  const errorPanel = alert.closest("section");
  expect(errorPanel).toHaveTextContent("读取失败");
  expect(errorPanel).not.toHaveTextContent("Gate2 已禁用");
});

test("renders command state receipt and readback diff evidence", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(commandView({
    command_state: {
      status: "OUTCOME_UNKNOWN", state_version: 7,
      scheduled_for: "2026-08-28T15:30:00.000Z",
      safe_error_code: "TRIGGER_AMBIGUOUS",
      trigger_started_at: "2026-08-28T15:30:05.000Z",
      updated_at: "2026-08-28T15:31:00.000Z",
    },
    receipt: {
      status: "APPLIED", provider_mutation_count: 1,
      created_at: "2026-08-28T15:30:30.000Z",
    },
    readbacks: [{
      id: "readback-1", diff_codes: ["BODY_MISMATCH", "IMAGE_MISMATCH"],
      safe_error_code: "READBACK_MISMATCH", created_at: "2026-08-28T15:32:00.000Z",
    }],
  }))));

  render(<GbpExecutionPanel canExecute onReadback={() => undefined} task={{ ...task, status: "OUTCOME_UNKNOWN" }} />);
  const panel = await screen.findByRole("region", { name: "GBP 执行" });
  for (const evidence of [
    "OUTCOME_UNKNOWN", "state v7", "TRIGGER_AMBIGUOUS", "APPLIED",
    "mutation 1", "BODY_MISMATCH", "IMAGE_MISMATCH", "READBACK_MISMATCH",
  ]) expect(panel).toHaveTextContent(evidence);
});

test.each([
  "DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL", "APPROVED",
  "REVISION_REQUIRED", "APPROVAL_REVOKED", "EXECUTION_CONFIRMED", "DISPATCHING",
  "OUTCOME_UNKNOWN", "PENDING_VERIFY", "VERIFIED", "DONE", "FAILED",
] satisfies SeoTaskStatus[])(
  "mounts the dedicated GBP panel for %s",
  async (status) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      json(String(input).includes("/attempts") ? { items: [] } : commandView({
        command_state: {
          ...commandView().command_state!,
          status,
        },
      })),
    ));

    render(<ExecutionPanel canExecute onReadback={() => undefined} task={{ ...task, status }} />);
    expect(await screen.findByRole("region", { name: "GBP 执行" })).toBeInTheDocument();
  },
);
