import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MerchantKeywordRankingPanel } from "./MerchantKeywordRankingPanel";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("shows the merchant keyword set and truthful Local/Organic ranking evidence", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [
    {
      id: "keywords", task_id: "task-keywords", merchant_id: "choice-uws", artifact_type: "KEYWORD_SET",
      schema_version: "seo_ops.keyword_set.v2", title: "UWS keywords", summary: "US keyword set",
      payload: { market: { country_code: "US", language: "en-US" }, keywords: [
        { keyword: "bakery upper west side", strategy: "LOCAL", intent: "LOCAL", priority: "P1" },
        { keyword: "broadway coffee", strategy: "LOCAL", intent: "LOCAL", priority: "P2" },
      ] }, core_run_id: "core-keywords", created_by: "system", created_at: "2026-08-20T12:00:00Z",
      acceptance_status: "ACCEPTED",
    },
    {
      id: "ranking", task_id: "task-ranking", merchant_id: "choice-uws", artifact_type: "RANKING_SNAPSHOT",
      schema_version: "seo_ops.ranking_report.v1", title: "UWS ranking", summary: "Live ranking",
      payload: { captured_at: "2026-08-14T12:00:00Z", source_mode: "LIVE_READ_ONLY", keywords: [
        { keyword: "bakery upper west side", local_rank: 2, organic_rank: null, source: "LIVE_READ_ONLY" },
        { keyword: "broadway coffee", local_rank: null, organic_rank: null, source: "UNAVAILABLE" },
      ] }, core_run_id: "core-ranking", created_by: "system", created_at: "2026-08-20T12:00:00Z",
      acceptance_status: "ACCEPTED",
    },
  ] }), { headers: { "Content-Type": "application/json" } })));

  render(<MerchantKeywordRankingPanel merchantId="choice-uws" />);

  expect(await screen.findByRole("heading", { name: "关键词与排名" })).toBeInTheDocument();
  expect(screen.getByText("2 个目标词")).toBeInTheDocument();
  const ranked = screen.getByRole("row", { name: /bakery upper west side/ });
  expect(within(ranked).getByText("#2")).toBeInTheDocument();
  const unavailable = screen.getByRole("row", { name: /broadway coffee/ });
  expect(within(unavailable).getAllByText("Top 20 未出现")).toHaveLength(2);
  expect(screen.getByText(/LIVE_READ_ONLY/)).toBeInTheDocument();
});

test("does not describe missing ranking evidence as a Top 20 miss", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [{
    id: "keywords-only", task_id: "task-keywords", merchant_id: "george", artifact_type: "KEYWORD_SET",
    schema_version: "seo_ops.keyword_set.v2", title: "George keywords", summary: "Current keyword set",
    payload: { keywords: [{ keyword: "hakka", strategy: "CUISINE", priority: "HIGH" }] },
    core_run_id: "source-keywords", created_by: "system", created_at: "2026-08-27T06:00:00Z",
    acceptance_status: "ACCEPTED",
  }] }), { headers: { "Content-Type": "application/json" } })));

  render(<MerchantKeywordRankingPanel merchantId="george" />);

  const row = await screen.findByRole("row", { name: /hakka/ });
  expect(within(row).getAllByText("尚未采集")).toHaveLength(2);
  expect(within(row).queryByText("Top 20 未出现")).not.toBeInTheDocument();
  expect(screen.getByText("关键词已验收")).toBeInTheDocument();
});
