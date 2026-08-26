import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import type { WorkbenchView } from "../../api/types";
import { portfolioFixture, userFixture } from "../../test/fixtures";
import "../../styles/ledger.css";

const defaultWorkbenchData: WorkbenchView = {
  summary: { gatekeeping: 2, exception: 1, merchant_contact: 1, total: 4 },
  items: [
    {
      id: "outcome:attempt-1", group: "EXCEPTION", type: "OUTCOME_RECONCILIATION",
      merchant_id: "choice-brooklyn", merchant_name: "Choice Brooklyn UWS", location_name: "Upper West Side",
      title: "核对执行结果", reason: "结果不确定，需要人工查证后才能继续。",
      primary_action: { label: "去查证", href: "/runs?attempt=attempt-1" }, secondary_href: "/merchants/choice-brooklyn",
      priority: "URGENT", due_at: null, waiting_since: "2026-08-26T01:00:00.000Z",
    },
    {
      id: "proposal:proposal-1", group: "GATEKEEPING", type: "PROPOSAL_DECISION",
      merchant_id: "choice-brooklyn", merchant_name: "Choice Brooklyn UWS", location_name: "Upper West Side",
      title: "决定是否采纳建议", reason: "新的优化建议等待你的判断。",
      primary_action: { label: "去判定", href: "/inbox?tab=proposals" }, secondary_href: null,
      priority: "HIGH", due_at: null, waiting_since: "2026-08-26T02:00:00.000Z",
    },
    {
      id: "artifact:artifact-1", group: "GATEKEEPING", type: "ARTIFACT_ACCEPTANCE",
      merchant_id: "choice-brooklyn", merchant_name: "Choice Brooklyn UWS", location_name: "Upper West Side",
      title: "Audit output awaiting acceptance", reason: "Agent 产物已落库，等待人工接受或拒绝。",
      primary_action: { label: "验收 Agent 产物", href: "/tasks/task-audit" }, secondary_href: null,
      priority: "HIGH", due_at: null, waiting_since: "2026-08-26T02:30:00.000Z",
    },
    {
      id: "questionnaire:q-1", group: "MERCHANT_CONTACT", type: "QUESTIONNAIRE_FOLLOWUP",
      merchant_id: "choice-brooklyn", merchant_name: "Choice Brooklyn UWS", location_name: null,
      title: "跟进问卷", reason: "商户尚未回复需要确认的信息。",
      primary_action: { label: "去联络", href: "/merchants/choice-brooklyn" }, secondary_href: null,
      priority: "MEDIUM", due_at: null, waiting_since: "2026-08-25T02:00:00.000Z",
    },
  ],
  offset: 0,
  limit: 50,
  total: 3,
};

let workbenchData: WorkbenchView = defaultWorkbenchData;

beforeEach(() => {
  workbenchData = structuredClone(defaultWorkbenchData);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/auth/me") return json(userFixture);
    if (path === "/api/seo-ops/portfolio") return json(portfolioFixture);
    if (path === "/api/seo-ops/config") return json({ copilot_enabled: false, copilot_agent_id: null, agent_run_enabled: false, agent_run_stages: [] });
    if (path.startsWith("/api/seo-ops/workbench")) return json(workbenchData);
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("workbench groups human actions and gives each row one primary action", async () => {
  renderApp("/");

  expect(await screen.findByRole("heading", { name: "今天需要我处理" })).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "例外" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "把关" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "商户联络" })).toBeInTheDocument();
  const row = screen.getByRole("article", { name: /Choice Brooklyn UWS.*结果不确定/ });
  expect(within(row).getAllByRole("button")).toHaveLength(1);
  expect(within(row).getByRole("button", { name: "去查证" })).toBeInTheDocument();
  const artifactRow = screen.getByRole("article", { name: /Choice Brooklyn UWS.*Agent 产物已落库/ });
  expect(within(artifactRow).getAllByRole("button")).toHaveLength(1);
  expect(within(artifactRow).getByRole("button", { name: "验收 Agent 产物" })).toBeInTheDocument();
});

test("empty workbench explains the next automated windows without demo tasks", async () => {
  workbenchData = { summary: { gatekeeping: 0, exception: 0, merchant_contact: 0, total: 0 }, items: [], offset: 0, limit: 50, total: 0 };
  renderApp("/");

  expect(await screen.findByText("今天没有需要人工处理的事项")).toBeInTheDocument();
  expect(screen.queryByText(/FRONTEND DEMO/)).not.toBeInTheDocument();
});

test("workbench decision rows keep their minimum vertical geometry within 44px", async () => {
  renderApp("/");

  const row = await screen.findByRole("article", { name: /Choice Brooklyn UWS.*结果不确定/ });
  const action = within(row).getByRole("button", { name: "去查证" });
  const rowStyle = window.getComputedStyle(row);
  const actionStyle = window.getComputedStyle(action);
  const rowMinimum = Number.parseFloat(rowStyle.minHeight);
  const controlMinimum = Number.parseFloat(actionStyle.minHeight);
  const verticalPadding = Number.parseFloat(rowStyle.paddingTop) + Number.parseFloat(rowStyle.paddingBottom);

  expect(controlMinimum).toBeGreaterThanOrEqual(32);
  expect(Math.max(rowMinimum, controlMinimum + verticalPadding)).toBeLessThanOrEqual(44);
});

test("decision rows expose merchant and waiting labels when dense rows reflow", async () => {
  renderApp("/");

  const row = await screen.findByRole("article", { name: /Choice Brooklyn UWS.*结果不确定/ });
  expect(within(row).getByText("Choice Brooklyn UWS").closest("[data-label='商户']")).toBeInTheDocument();
  expect(row.querySelector("time[data-label='等待']")).toBeInTheDocument();
});

test("decision copy wraps below 900px while the primary action stays visible", async () => {
  renderApp("/");

  const row = await screen.findByRole("article", { name: /Choice Brooklyn UWS.*结果不确定/ });
  const title = within(row).getByText("核对执行结果");
  const reason = within(row).getByText("结果不确定，需要人工查证后才能继续。");
  const merchant = within(row).getByText("Choice Brooklyn UWS");
  const location = within(row).getByText("Upper West Side");

  expect([title, reason, merchant, location].every((value) => value.textContent?.trim())).toBe(true);
  expect(within(row).getByRole("button", { name: "去查证" })).toBeVisible();
  const responsiveRule = Array.from(document.styleSheets)
    .flatMap((sheet) => Array.from(sheet.cssRules))
    .find((rule) => rule.cssText.includes("@media (max-width: 900px)"))?.cssText ?? "";
  expect(responsiveRule).toContain(".action-copy strong, .action-copy p, .merchant-context strong, .merchant-context small");
  expect(responsiveRule).toContain("overflow-wrap: anywhere");
  expect(responsiveRule).toContain("white-space: normal");
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
