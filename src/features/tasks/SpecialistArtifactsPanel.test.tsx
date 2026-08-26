import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SpecialistArtifactWire } from "../../api/types";
import { SpecialistArtifactsPanel } from "./SpecialistArtifactsPanel";

const artifacts: SpecialistArtifactWire[] = [
  {
    id: "artifact-merchant-report",
    task_id: "task-report-package",
    merchant_id: "merchant-1",
    artifact_type: "MERCHANT_REPORT" as SpecialistArtifactWire["artifact_type"],
    schema_version: "seo_ops.merchant_report.v1",
    title: "August merchant report",
    summary: "A frozen merchant-safe report package.",
    payload: {
      report_version: "2026-08-v1",
      frozen_at: "2026-08-27T00:00:00.000Z",
      executive_summary: "Accepted audit and ranking evidence only.",
      sections: [{
        id: "audit",
        title: "Audit findings",
        body: "The location page remains the highest-priority accepted gap.",
        source_artifact_ids: ["artifact-audit"],
      }],
      source_artifact_ids: ["artifact-audit"],
      limitations: ["Report excludes connected Search Console data."],
    },
    core_run_id: "core-merchant-report",
    created_by: "system:specialist-agent",
    created_at: "2026-08-27T12:00:00.000Z",
    acceptance_status: "ACCEPTED",
    acceptance_decided_by: "op-1",
    acceptance_decided_at: "2026-08-27T12:30:00.000Z",
    acceptance_note: "Approved for merchant reporting.",
  },
  {
    id: "artifact-effect-review",
    task_id: "task-effect-review",
    merchant_id: "merchant-1",
    artifact_type: "EFFECT_REVIEW" as SpecialistArtifactWire["artifact_type"],
    schema_version: "seo_ops.effect_review.v1",
    title: "30-day effect review",
    summary: "Observed movement after the accepted action bundle.",
    payload: {
      conclusion_tier: "ASSOCIATIONAL",
      conclusion: "The measured change is associated with, but not proven caused by, the accepted work.",
      action_bundle: [{ action_id: "gbp-post-1" }],
      planning_signals: [{ signal: "continue measurement" }],
      confounders: ["Seasonality was not controlled."],
      limitations: ["No randomized control."],
    },
    core_run_id: "core-effect-review",
    created_by: "system:specialist-agent",
    created_at: "2026-08-27T11:00:00.000Z",
    acceptance_status: "PENDING",
  },
  {
    id: "artifact-weekly-signal",
    task_id: "task-weekly",
    merchant_id: "merchant-1",
    artifact_type: "KEYWORD_WEEKLY",
    schema_version: "seo_ops.keyword_weekly_signal.v1",
    title: "Weekly cluster signal",
    summary: "Associative weekly reading.",
    payload: {
      observed_at: "2026-08-26T08:00:00.000Z",
      cluster_signals: [{ cluster: "weekday lunch", signal: "IMPROVED", evidence_ref: "ranking:week-34" }],
    },
    core_run_id: "core-weekly",
    created_by: "system:specialist-agent",
    created_at: "2026-08-26T10:30:00.000Z",
  },
  {
    id: "artifact-plan",
    task_id: "task-plan",
    merchant_id: "merchant-1",
    artifact_type: "EXECUTION_PLAN",
    schema_version: "seo_ops.execution_plan.v1",
    title: "30-day execution plan",
    summary: "Turn evidence into ordered work.",
    payload: {
      horizon_days: 30,
      work_items: [{ id: "page", title: "Create Mineola location page", priority: "HIGH" }],
    },
    core_run_id: "core-plan",
    created_by: "system:specialist-agent",
    created_at: "2026-08-26T10:00:00.000Z",
  },
  {
    id: "artifact-ranking",
    task_id: "task-ranking",
    merchant_id: "merchant-1",
    artifact_type: "RANKING_SNAPSHOT",
    schema_version: "seo_ops.ranking_report.v1",
    title: "Initial ranking baseline",
    summary: "One supplied keyword with unavailable live rank.",
    payload: {
      source_mode: "CONFIRMED_FACTS_ONLY",
      keywords: [{ keyword: "family lunch mineola", local_rank: null, organic_rank: null, source: "UNAVAILABLE" }],
      limitations: ["Local grid is not connected."],
    },
    core_run_id: "core-ranking",
    created_by: "system:specialist-agent",
    created_at: "2026-08-26T09:30:00.000Z",
  },
  {
    id: "artifact-audit",
    task_id: "task-audit",
    merchant_id: "merchant-1",
    artifact_type: "AUDIT_REPORT",
    schema_version: "seo_ops.audit_report.v1",
    title: "Evidence-bounded audit",
    summary: "One high-priority website gap.",
    payload: {
      findings: [{ id: "gap", area: "WEBSITE", severity: "HIGH", observation: "Missing location page." }],
      limitations: ["Search Console is not connected."],
    },
    core_run_id: "core-audit",
    created_by: "system:specialist-agent",
    created_at: "2026-08-26T09:00:00.000Z",
    acceptance_status: "REJECTED",
    acceptance_decided_by: "op-1",
    acceptance_decided_at: "2026-08-26T09:15:00.000Z",
    acceptance_note: "Missing evidence.",
  },
  {
    id: "artifact-keywords",
    task_id: "task-keywords",
    merchant_id: "merchant-1",
    artifact_type: "KEYWORD_SET",
    schema_version: "seo_ops.keyword_set.v2",
    title: "Confirmed keyword set",
    summary: "Keywords from confirmed merchant facts.",
    payload: {
      market: { country_code: "US", language: "en-US", search_engine: "GOOGLE", location_name: "Mineola, NY" },
      generation_method: "UPSTREAM_DETERMINISTIC_ADAPTER",
      keywords: [
        { keyword: "family lunch mineola", priority: "P0", strategy: "LOCAL", intent: "LOCAL" },
        { keyword: "restaurant catering mineola", priority: "P2", strategy: "ORGANIC", intent: "ORGANIC" },
      ],
      evidence_gaps: ["Live search volume is not connected."],
    },
    core_run_id: "core-keywords",
    created_by: "system:specialist-agent",
    created_at: "2026-08-26T08:00:00.000Z",
  },
  {
    id: "artifact-future-output",
    task_id: "task-future-output",
    merchant_id: "merchant-1",
    artifact_type: "FUTURE_OUTPUT" as SpecialistArtifactWire["artifact_type"],
    schema_version: "seo_ops.future_output.v1",
    title: "Future specialist output",
    summary: "A newer server type must not crash this older client.",
    payload: { future_field: "safe fallback" },
    core_run_id: "core-future-output",
    created_by: "system:specialist-agent",
    created_at: "2026-08-26T07:00:00.000Z",
  },
];

describe("SpecialistArtifactsPanel", () => {
  it("turns specialist JSON into an operations-readable result view", () => {
    render(<SpecialistArtifactsPanel artifacts={artifacts} />);

    expect(screen.getByRole("heading", { name: "Agent 产物" })).toBeInTheDocument();
    expect(screen.getByText("1 个簇 · 关联信号")).toBeInTheDocument();
    expect(screen.getByText("weekday lunch")).toBeInTheDocument();
    expect(screen.getByText("30 天 · 1 项工作")).toBeInTheDocument();
    expect(screen.getByText("Create Mineola location page")).toBeInTheDocument();
    expect(screen.getByText("1 项发现 · 1 项高风险")).toBeInTheDocument();
    expect(screen.getByText("Missing location page.")).toBeInTheDocument();
    expect(screen.getByText("1 个词 · 0 个已测排名")).toBeInTheDocument();
    expect(screen.getByText("Local grid is not connected.")).toBeInTheDocument();
    expect(screen.getByText("2 个词 · 1 个 P0/P1")).toBeInTheDocument();
    expect(screen.getByText("确定性链路适配")).toBeInTheDocument();
    expect(screen.getAllByText("family lunch mineola")).toHaveLength(2);
    expect(screen.getByText("Search Console is not connected.")).toBeInTheDocument();
    expect(screen.getByText("复盘分析")).toBeInTheDocument();
    expect(screen.getByText("ASSOCIATIONAL · 1 项已执行动作")).toBeInTheDocument();
    expect(screen.getByText("The measured change is associated with, but not proven caused by, the accepted work.")).toBeInTheDocument();
    expect(screen.getByText("商户报告")).toBeInTheDocument();
    expect(screen.getByText("2026-08-v1 · 1 个章节")).toBeInTheDocument();
    expect(screen.getByText("Audit findings")).toBeInTheDocument();
    expect(screen.getByText("未知 Agent 产物")).toBeInTheDocument();
    expect(screen.getByText("未知结构 · 安全回退")).toBeInTheDocument();
    expect(screen.getByText("已验收")).toBeInTheDocument();
    expect(screen.getByText("待验收")).toBeInTheDocument();
    expect(screen.getByText("已拒绝")).toBeInTheDocument();
    expect(screen.getAllByText("验收状态未知").length).toBeGreaterThan(0);
  });
});
