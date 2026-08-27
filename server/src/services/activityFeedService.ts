import type { Db } from "../db/connection.js";
import { listAgentRunsForSummary } from "../repos/agentRunRepo.js";
import { listMerchants, listMerchantsForOperator } from "../repos/merchantRepo.js";
import { listTasks } from "../repos/taskRepo.js";
import { listBatchViews } from "./proposalService.js";

export type ActivitySeverity = "INFO" | "WARN" | "DANGER";
export interface ActivityItemWire {
  id: string; kind: "TASK_EVENT" | "AGENT_RUN" | "PROPOSAL_BATCH";
  occurred_at: string; merchant_id: string; merchant_name: string;
  title: string; detail: string | null; href: string; severity: ActivitySeverity;
}
export interface ActivityFeedWire { items: ActivityItemWire[]; since: string }

const TASK_EVENT_COPY: Record<string, { title: string; severity: ActivitySeverity }> = {
  TASK_CREATED: { title: "任务已创建", severity: "INFO" },
  TASK_REVISED: { title: "任务新修订（旧审批作废）", severity: "INFO" },
  EVIDENCE_APPENDED: { title: "证据已附加", severity: "INFO" },
  CONTENT_DRAFT_REVISED: { title: "内容稿已更新", severity: "INFO" },
  AUTO_AUTHORIZED: { title: "只读任务按周期预授权", severity: "INFO" },
  EXECUTION_CONFIRMED: { title: "门 2 执行确认已登记", severity: "INFO" },
  GBP_EXECUTION_CONFIRMED: { title: "GBP 发布确认已登记", severity: "INFO" },
  ATTEMPT_DISPATCHING: { title: "已派发 attempt，等待 Core AI 终态", severity: "INFO" },
  EXECUTION_SUCCEEDED: { title: "执行成功 · 进入核验（发布 ≠ 已验证）", severity: "INFO" },
  EXECUTION_FAILED: { title: "执行失败已确认，未产生外部写入", severity: "WARN" },
  OUTCOME_UNKNOWN: { title: "执行结果不确定 · 该商户执行链已冻结", severity: "DANGER" },
  VERIFIED: { title: "核验通过", severity: "INFO" },
  TASK_DONE: { title: "任务已完成归档", severity: "INFO" },
  MANUAL_COMPLETED: { title: "人工完成已记录", severity: "INFO" },
  FAILED_RESET: { title: "排障后重置回已批准", severity: "WARN" },
  CONVERSATION_LINKED: { title: "对话已关联", severity: "INFO" },
};

export function describeTaskEvent(type: string): { title: string; severity: ActivitySeverity } {
  return TASK_EVENT_COPY[type] ?? { title: type, severity: type.includes("FAIL") || type.includes("REVOK") ? "WARN" : "INFO" };
}

/** 今日信号：任务事件 + Run 终态 + 建议批次，纯只读投影，按时间倒序。 */
export async function activityFeed(
  db: Db,
  actorUserId: string,
  scopeAll: boolean,
  options: { hours: number; limit: number },
  now: Date = new Date(),
): Promise<ActivityFeedWire> {
  const merchants = scopeAll ? await listMerchants(db) : await listMerchantsForOperator(db, actorUserId);
  const names = new Map(merchants.map((m) => [m.id, m.displayName]));
  const since = new Date(now.getTime() - options.hours * 3_600_000).toISOString();
  const items: ActivityItemWire[] = [];

  for (const task of (await listTasks(db)).filter((t) => names.has(t.merchantId))) {
    for (const event of task.events) {
      if (event.occurredAt < since) continue;
      const copy = describeTaskEvent(event.type);
      items.push({
        id: `event:${event.id}`, kind: "TASK_EVENT", occurred_at: event.occurredAt,
        merchant_id: task.merchantId, merchant_name: names.get(task.merchantId)!,
        title: copy.title, detail: task.title, href: `/tasks/${task.id}`, severity: copy.severity,
      });
    }
  }

  for (const run of await listAgentRunsForSummary(db, scopeAll ? null : [...names.keys()], since)) {
    if (!run.completedAt || run.completedAt < since || !names.has(run.merchantId)) continue;
    if (run.status !== "COMPLETED" && run.status !== "FAILED") continue;
    items.push({
      id: `run:${run.id}`, kind: "AGENT_RUN", occurred_at: run.completedAt,
      merchant_id: run.merchantId, merchant_name: names.get(run.merchantId)!,
      title: run.status === "COMPLETED" ? `${run.stage} Run 完成` : `${run.stage} Run 失败${run.errorCode ? ` · ${run.errorCode}` : ""}`,
      detail: run.goal, href: run.taskId ? `/tasks/${run.taskId}` : `/runs?view=audit`,
      severity: run.status === "FAILED" ? "WARN" : "INFO",
    });
  }

  for (const view of (await listBatchViews(db)).filter((v) => names.has(v.batch.merchantId))) {
    if (view.batch.createdAt < since) continue;
    const pending = view.proposals.filter((p) => p.status === "PENDING" || p.status === "VALIDATION_FAILED").length;
    items.push({
      id: `batch:${view.batch.id}`, kind: "PROPOSAL_BATCH", occurred_at: view.batch.createdAt,
      merchant_id: view.batch.merchantId, merchant_name: names.get(view.batch.merchantId)!,
      title: `Planner 建议 ${view.proposals.length} 条${pending ? `（${pending} 条待判定）` : "（已判定）"}`,
      detail: view.batch.triggerReason, href: `/inbox?tab=proposals&merchant_id=${view.batch.merchantId}`,
      severity: "INFO",
    });
  }

  items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id));
  return { items: items.slice(0, options.limit), since };
}
