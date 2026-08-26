import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import { portfolioWithMerchants, userFixture, workbenchWithActions } from "../../test/fixtures";

const requestedPaths: string[] = [];
type WorkbenchResponder = (offset: number, limit: number, group: string | null) => Response | Promise<Response>;
let workbenchResponder: WorkbenchResponder;

beforeEach(() => {
  requestedPaths.length = 0;
  workbenchResponder = (offset, limit) => json(workbenchWithActions(107, { offset, pageSize: limit }));
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
      return workbenchResponder(offset, limit, url.searchParams.get("group"));
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

test("workbench normalizes repeated offsets while preserving the group query", async () => {
  renderAppWithLocation("/?group=EXCEPTION&offset=50&offset=100");

  await vi.waitFor(() => expect(requestedPaths).toContain("/api/seo-ops/workbench?group=EXCEPTION&offset=0&limit=50"));
  expect(screen.getByTestId("current-location")).toHaveTextContent("/?group=EXCEPTION&offset=0");
});

test("an out-of-range page recovers to the last server page without showing a false empty range", async () => {
  let resolveLastPage!: (response: Response) => void;
  const lastPage = new Promise<Response>((resolve) => { resolveLastPage = resolve; });
  workbenchResponder = (offset, limit) => {
    if (offset === 100) return json({ ...workbenchWithActions(51, { offset, pageSize: limit }), items: [] });
    if (offset === 50) return lastPage;
    return json(workbenchWithActions(51, { offset, pageSize: limit }));
  };
  renderApp("/?group=EXCEPTION&offset=100");

  await vi.waitFor(() => expect(requestedPaths).toContain("/api/seo-ops/workbench?group=EXCEPTION&offset=50&limit=50"));
  expect(screen.queryByText("今天没有需要人工处理的事项")).not.toBeInTheDocument();
  expect(screen.queryByText("显示 101–51 / 51")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("正在校正分页");

  await act(async () => {
    resolveLastPage(json(workbenchWithActions(51, { offset: 50, pageSize: 50 })));
    await lastPage;
  });
  expect(await screen.findByText("显示 51–51 / 51")).toBeInTheDocument();
});

test("a slow old page cannot overwrite the page selected most recently", async () => {
  let resolveOldPage!: (response: Response) => void;
  const oldPage = new Promise<Response>((resolve) => { resolveOldPage = resolve; });
  workbenchResponder = (offset, limit) => offset === 50
    ? oldPage
    : json(workbenchWithActions(107, { offset, pageSize: limit }));
  renderAppWithNavigation("/");
  const user = userEvent.setup();

  await screen.findByText("显示 1–50 / 107");
  await user.click(screen.getByRole("button", { name: "跳到第 2 页" }));
  await vi.waitFor(() => expect(requestedPaths).toContain("/api/seo-ops/workbench?group=EXCEPTION&offset=50&limit=50"));
  await user.click(screen.getByRole("button", { name: "跳到第 3 页" }));
  expect(await screen.findByText("显示 101–107 / 107")).toBeInTheDocument();

  await act(async () => {
    resolveOldPage(json(workbenchWithActions(107, { offset: 50, pageSize: 50 })));
    await oldPage;
  });
  expect(screen.getByText("显示 101–107 / 107")).toBeInTheDocument();
  expect(screen.queryByText("显示 51–100 / 107")).not.toBeInTheDocument();
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}{location.search}</output>;
}

function renderAppWithLocation(route: string) {
  return render(<MemoryRouter initialEntries={[route]}>
    <LocationProbe />
    <AuthProvider><App /></AuthProvider>
  </MemoryRouter>);
}

function PageNavigator() {
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate("/?group=EXCEPTION&offset=50")} type="button">跳到第 2 页</button>
    <button onClick={() => navigate("/?group=EXCEPTION&offset=100")} type="button">跳到第 3 页</button>
  </>;
}

function renderAppWithNavigation(route: string) {
  return render(<MemoryRouter initialEntries={[route]}>
    <PageNavigator />
    <AuthProvider><App /></AuthProvider>
  </MemoryRouter>);
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
