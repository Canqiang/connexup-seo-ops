import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { portfolioWithMerchants, userFixture, workbenchWithActions } from "../../test/fixtures";

const requestedPaths: string[] = [];

beforeEach(() => {
  requestedPaths.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    requestedPaths.push(path);
    if (path === "/api/auth/me") return json(userFixture);
    if (path === "/api/seo-ops/portfolio") return json(portfolioWithMerchants(100));
    if (path === "/api/seo-ops/inbox-summary") return json({ pending_proposals: 0, ready_for_approval: 0, awaiting_execution: 0, pending_verify: 0, outcome_unknown: 0, frozen_merchant_ids: [] });
    if (path === "/api/seo-ops/config") return json({ copilot_enabled: false, copilot_agent_id: null, agent_run_enabled: false, agent_run_stages: [] });
    if (path.startsWith("/api/seo-ops/workbench")) {
      const url = new URL(path, "https://seo-ops.test");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "50");
      return json(workbenchWithActions(107, { offset, pageSize: limit }));
    }
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

test("100 merchant names remain searchable while the workbench renders one server page", async () => {
  const user = userEvent.setup();
  renderApp("/");

  expect(await screen.findAllByRole("article", { name: /Merchant \d{3}.*需要人工查证/ })).toHaveLength(50);
  expect(screen.getByText("显示 1–50 / 107")).toBeInTheDocument();
  expect(screen.getAllByRole("combobox")).toHaveLength(1);

  await user.click(screen.getByRole("combobox"));
  await user.type(screen.getByRole("searchbox", { name: "搜索商户、门店或负责人" }), "Merchant 087");

  expect(screen.getByRole("option", { name: /Merchant 087/ })).toBeInTheDocument();
  expect(screen.queryByText(/FRONTEND DEMO/)).not.toBeInTheDocument();
});

test("workbench pagination requests the next 50 records and resets offset when a group filter changes", async () => {
  const user = userEvent.setup();
  renderApp("/");

  await user.click(await screen.findByRole("button", { name: "下一页" }));
  expect(await screen.findByText("显示 51–100 / 107")).toBeInTheDocument();
  expect(requestedPaths).toContain("/api/seo-ops/workbench?offset=50&limit=50");

  await user.click(screen.getByRole("button", { name: /例外/ }));
  expect(await screen.findByText("显示 1–50 / 107")).toBeInTheDocument();
  expect(requestedPaths).toContain("/api/seo-ops/workbench?group=EXCEPTION&offset=0&limit=50");
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
