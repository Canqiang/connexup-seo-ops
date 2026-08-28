import type { Db } from "../db/connection.js";
import { listAgentRunsForSummary, listAgentRunsPage, listDeliverablesByRunIds } from "../repos/agentRunRepo.js";
import type { AgentRun } from "../repos/agentRunTypes.js";
import { listOpenUnknownAttempts } from "../repos/executionRepo.js";
import { listMerchants, listMerchantsForOperator } from "../repos/merchantRepo.js";

export interface RunLedgerRowWire {
  id: string; merchant_id: string; merchant_name: string; location_id: string | null;
  task_id: string | null; stage: string; run_type: string; status: string;
  core_run_id: string | null; trace_ref: string | null; error_code: string | null;
  triggered_by: string; triggered_at: string; completed_at: string | null;
  duration_ms: number | null; token_total: number; deliverable_count: number;
}

export interface RunsLedgerWire {
  summary: {
    in_flight: number; queued: number; completed_today: number; failed_today: number;
    content_runs_today: number; token_total_today: number;
    outcome_unknown: number; frozen_merchant_ids: string[];
    day_start: string;
  };
  items: RunLedgerRowWire[]; offset: number; limit: number; total: number;
}

export interface RunsLedgerQuery {
  actorUserId: string; scopeAll: boolean; merchantId?: string; status?: string; stage?: string;
  includeContentRuns: boolean; offset: number; limit: number; tzOffsetMinutes: number;
}

/** Core AI 的 token_usage 字段不统一：有 total 用 total，否则把数值字段相加。 */
export function tokenTotal(usage: Record<string, number>): number {
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  if (typeof usage.total === "number") return usage.total;
  return Object.values(usage).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

/** 运营者本地时区的当日零点，表示为 UTC 时刻。offsetMinutes = UTC+X 的分钟数
 * （前端传 -new Date().getTimezoneOffset()）；0 = UTC，保持旧行为。 */
function localDayStart(now: Date, offsetMinutes: number): string {
  const local = now.getTime() + offsetMinutes * 60_000;
  const localMidnight = Math.floor(local / 86_400_000) * 86_400_000;
  return new Date(localMidnight - offsetMinutes * 60_000).toISOString();
}

/** 一个 Run 归属的「日」：终态按完成时刻，未终态按创建时刻。 */
function dayAnchor(run: AgentRun): string {
  return run.completedAt ?? run.createdAt;
}

function durationMs(run: AgentRun): number | null {
  if (!run.completedAt) return null;
  const ms = Date.parse(run.completedAt) - Date.parse(run.triggeredAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Run 账本：只读 seo_agent_runs；Run 完成 ≠ Task 完成，这里不碰任务状态。 */
export async function runsLedger(db: Db, query: RunsLedgerQuery, now: Date = new Date()): Promise<RunsLedgerWire> {
  const merchants = query.scopeAll ? await listMerchants(db) : await listMerchantsForOperator(db, query.actorUserId);
  const names = new Map(merchants.map((m) => [m.id, m.displayName]));
  const scopedIds = merchants.map((m) => m.id);
  const merchantIds = query.merchantId ? scopedIds.filter((id) => id === query.merchantId) : (query.scopeAll ? null : scopedIds);

  const page = await listAgentRunsPage(db, {
    merchantIds, status: query.status, stage: query.stage,
    includeContentRuns: query.includeContentRuns, offset: query.offset, limit: query.limit,
  });
  const deliverables = await listDeliverablesByRunIds(db, page.items.map((run) => run.id));

  const dayStart = localDayStart(now, query.tzOffsetMinutes);
  const recent = await listAgentRunsForSummary(db, query.scopeAll ? null : scopedIds, dayStart);
  const today = recent.filter((run) => dayAnchor(run) >= dayStart);
  const unknown = (await listOpenUnknownAttempts(db)).filter((a) => query.scopeAll || names.has(a.merchantId));

  return {
    summary: {
      in_flight: recent.filter((run) => run.status === "RUNNING").length,
      queued: recent.filter((run) => run.status === "TRIGGERING").length,
      completed_today: today.filter((run) => run.status === "COMPLETED" && run.stage !== "GBP_POST_CONTENT").length,
      failed_today: today.filter((run) => run.status === "FAILED").length,
      content_runs_today: today.filter((run) => run.stage === "GBP_POST_CONTENT").length,
      token_total_today: today.reduce((sum, run) => sum + tokenTotal(run.tokenUsage), 0),
      outcome_unknown: unknown.length,
      frozen_merchant_ids: [...new Set(unknown.map((a) => a.merchantId))],
      day_start: dayStart,
    },
    items: page.items.map((run) => ({
      id: run.id, merchant_id: run.merchantId, merchant_name: names.get(run.merchantId) ?? run.merchantId,
      location_id: run.locationId, task_id: run.taskId, stage: run.stage, run_type: run.runType, status: run.status,
      core_run_id: run.coreRunId, trace_ref: run.traceRef, error_code: run.errorCode,
      triggered_by: run.triggeredBy, triggered_at: run.triggeredAt, completed_at: run.completedAt,
      duration_ms: durationMs(run), token_total: tokenTotal(run.tokenUsage),
      deliverable_count: (deliverables.get(run.id) ?? []).length,
    })),
    offset: query.offset, limit: query.limit, total: page.total,
  };
}
