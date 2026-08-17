import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import { portfolioFixture, taskFixture, userFixture } from "./test/fixtures";

beforeEach(() => {
  localStorage.setItem("apiKey", "test-key");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/auth/me") return json(userFixture);
    if (path === "/api/seo-ops/portfolio") return json(portfolioFixture);
    if (path === "/api/seo-ops/config") return json({ copilot_enabled: true, copilot_agent_id: "agent-safe" });
    if (path === "/api/seo-ops/tasks/task-1") return json(taskFixture);
    if (path.startsWith("/api/seo-ops/tasks/task-1/events")) return json({ items: [], offset: 0, limit: 100, total: 0 });
    if (path.startsWith("/api/seo-ops/inbox")) return json({ items: [], offset: 0, limit: 50, total: 0 });
    if (path.startsWith("/api/seo-ops/reviews")) return json({ items: [], offset: 0, limit: 50, total: 0 });
    if (path.startsWith("/api/seo-ops/reports")) return json({ items: [], offset: 0, limit: 50, total: 0 });
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

test("portfolio keeps merchants in a searchable switcher", async () => {
  const user = userEvent.setup();
  renderApp("/");
  expect(await screen.findByRole("heading", { name: "代运营组合" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Only Bear Chicken & Boba" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "选择商户工作范围" }));
  expect(screen.getByRole("option", { name: /Only Bear Chicken & Boba/ })).toBeInTheDocument();
});

test("task deep link exposes revision hash evidence and approval boundary", async () => {
  const user = userEvent.setup();
  renderApp("/tasks/task-1");
  expect(await screen.findByRole("heading", { name: "菜单页发布证据复核" })).toBeInTheDocument();
  expect(screen.getByText("rev 2")).toBeInTheDocument();
  expect(screen.getByText("sha256:abc123")).toBeInTheDocument();
  expect(screen.getByText("批准只记录授权，不触发执行")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "打开 SEO Ops Copilot" }));
  expect(screen.getByRole("button", { name: "执行外部写入（MVP 禁用）" })).toBeDisabled();
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
