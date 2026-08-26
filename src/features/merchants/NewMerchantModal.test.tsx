import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { NewMerchantModal } from "./NewMerchantModal";

const calls: Array<{ path: string; body: unknown }> = [];
let plannerEnqueued = true;

beforeEach(() => {
  calls.length = 0;
  plannerEnqueued = true;
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-1111-1111-111111111111");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, body });
    if (path === "/api/seo-ops/merchants" && init?.method === "POST") {
      return new Response(JSON.stringify({
        id: "merchant-new-store",
        slug: "new-store",
        display_name: "New Store",
        tags: [],
        operator_user_ids: ["op-1"],
        planner_enqueued: plannerEnqueued,
        planner_task_id: plannerEnqueued ? "planner-task-1" : null,
        created_at: "2026-08-26T10:00:00.000Z",
        updated_at: "2026-08-26T10:00:00.000Z",
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "unexpected request" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("new merchant onboarding submits one Planner-triggering request instead of creating and sending a questionnaire in the browser", async () => {
  const user = userEvent.setup();
  const onDone = vi.fn();
  render(<NewMerchantModal onClose={vi.fn()} onDone={onDone} />);

  await user.type(screen.getByLabelText("店名"), "New Store");
  await user.type(screen.getByLabelText(/官网/), "https://new-store.example");
  await user.click(screen.getByRole("button", { name: "创建商户并生成任务计划" }));

  expect(await screen.findByText("新店已进入任务编排")).toBeInTheDocument();
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([{
    path: "/api/seo-ops/merchants",
    body: {
      slug: "new-store",
      display_name: "New Store",
      website: "https://new-store.example",
      idempotency_key: "new-merchant-11111111-1111-1111-1111-111111111111",
    },
  }]);
});

test("new merchant onboarding uses a neutral fictional example", () => {
  render(<NewMerchantModal onClose={vi.fn()} onDone={vi.fn()} />);

  expect(screen.getByPlaceholderText("例如：Harbor Lantern Cafe")).toBeInTheDocument();
  expect(screen.queryByPlaceholderText(/Only Bear/)).not.toBeInTheDocument();
});

test("new merchant onboarding reports a visible configuration wait when Planner is not bound", async () => {
  plannerEnqueued = false;
  const user = userEvent.setup();
  render(<NewMerchantModal onClose={vi.fn()} onDone={vi.fn()} />);

  await user.type(screen.getByLabelText("店名"), "Unbound Store");
  await user.click(screen.getByRole("button", { name: "创建商户并生成任务计划" }));

  expect(await screen.findByText("新店已登记，等待 Planner 配置")).toBeInTheDocument();
  expect(screen.getByText(/没有创建 Planner Task/)).toBeInTheDocument();
});
