import type { Db } from "../db/connection.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { findTaskByIdempotencyKey, listTasksByStatus } from "../repos/taskRepo.js";
import type { Task } from "../repos/taskTypes.js";
import { getAgentBinding, listCycleConfigs, type CycleConfig } from "../repos/settingsRepo.js";
import { createTask } from "./taskService.js";
import { autoDispatch, dispatchBindingKey } from "./executionService.js";
import { enqueuePlannerTaskIfBound } from "./plannerService.js";
import {
  AUTO_AUTHORIZABLE_SOURCES,
  authorizeReadOnlyTask,
} from "./readOnlyAuthorizationService.js";
import { effectiveRuntimePause } from "./runtimeControlService.js";

/** 周期驱动的Ⓐ级任务：由 scheduler 规则生成，周期配置即预授权 —— 不走 G1
 * 人工审批（用户决策：Audit/排名报告等只读任务全自动，不用人批）。写入类
 * （GBP_POST）由周期生成但停在双门前，内容定稿后走 G1+G2。 */

export interface SchedulerDeps {
  db: Db;
  systemActor?: string;
  log?: (message: string, err?: unknown) => void;
  now?: () => Date;
}

export interface CycleTaskSpec {
  key: string;
  taskType: string;
  title: string;
  executionMode: "READ_ONLY" | "AUTO_WRITE";
  requiredEvidenceTypes: string[];
  spec: Record<string, unknown>;
  priority: string;
}

function isoWeek(d: Date): string {
  // ISO-8601 week number, UTC.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function daysSinceEpoch(d: Date): number {
  return Math.floor(d.getTime() / 86400000);
}

/** 计算某商户当天应存在的周期任务（键是确定性的：同一周期只会生成一次）。 */
export function dueCycleTasks(cfg: CycleConfig, now: Date): CycleTaskSpec[] {
  const out: CycleTaskSpec[] = [];
  const m = cfg.merchantId;
  const week = isoWeek(now);
  const month = monthKey(now);

  if (cfg.snapshotDay !== null && now.getUTCDate() === cfg.snapshotDay) {
    out.push({
      key: `cycle:${m}:REPORT:${month}`,
      taskType: "REPORT",
      title: `月度表现报告 ${month}`,
      executionMode: "READ_ONLY",
      requiredEvidenceTypes: [],
      spec: {
        cycle: "MONTHLY_REPORT",
        period: month,
        includes: ["local_falcon_scan", "gbp_insights", "gsc", "review_summary"],
      },
      priority: "MEDIUM",
    });
  }

  if (cfg.postWeekday !== null && now.getUTCDay() === cfg.postWeekday) {
    out.push({
      key: `cycle:${m}:KEYWORD_WEEKLY:${week}`,
      taskType: "KEYWORD_WEEKLY",
      title: `关键词周分析 ${week}`,
      executionMode: "READ_ONLY",
      requiredEvidenceTypes: [],
      spec: { cycle: "KEYWORD_WEEKLY", period: week },
      priority: "MEDIUM",
    });
    for (let i = 1; i <= Math.max(0, cfg.postPerWeek); i += 1) {
      out.push({
        key: `cycle:${m}:GBP_POST:${week}:${i}`,
        taskType: "GBP_POST",
        title: `GBP Post ${week} #${i}`,
        executionMode: "AUTO_WRITE",
        // 内容定稿是硬性证据：没有定稿就到不了审批（Ⓑ 级的门在发布）。
        requiredEvidenceTypes: ["CONTENT_DRAFT"],
        spec: { cycle: "WEEKLY_POST", period: week, slot: i },
        priority: "MEDIUM",
      });
    }
  }

  if (cfg.auditIntervalDays !== null && cfg.auditIntervalDays > 0) {
    const bucket = Math.floor(daysSinceEpoch(now) / cfg.auditIntervalDays);
    out.push({
      key: `cycle:${m}:AUDIT:${bucket}`,
      taskType: "AUDIT",
      title: `定期健康审计 #${bucket}`,
      executionMode: "READ_ONLY",
      requiredEvidenceTypes: [],
      spec: { cycle: "PERIODIC_AUDIT", bucket, interval_days: cfg.auditIntervalDays },
      priority: "LOW",
    });
  }

  if (cfg.reviewWindowDays > 0) {
    const bucket = Math.floor(daysSinceEpoch(now) / cfg.reviewWindowDays);
    out.push({
      key: `cycle:${m}:REVIEW:${bucket}`,
      taskType: "REVIEW",
      title: `效果复盘 #${bucket}`,
      executionMode: "READ_ONLY",
      requiredEvidenceTypes: [],
      spec: { cycle: "REVIEW_SWEEP", bucket, window_days: cfg.reviewWindowDays },
      priority: "LOW",
    });
  }

  return out;
}

export interface SchedulerTickResult {
  created: Array<{ task_id: string; key: string; task_type: string; merchant_id: string }>;
  dispatched: number;
}

/** Deterministic occurrence coordinate for a deterministic cycle key. The
 * scheduler may observe the same due set many times; wall-clock tick time must
 * not change the idempotent Planner task body. */
function cycleSpecOccurrenceAt(spec: CycleTaskSpec, now: Date): string {
  const cycle = spec.spec.cycle;
  const period = spec.spec.period;
  if (cycle === "MONTHLY_REPORT" && typeof period === "string" && /^\d{4}-\d{2}$/.test(period)) {
    return `${period}-01T00:00:00.000Z`;
  }
  const bucket = spec.spec.bucket;
  const intervalDays = spec.spec.interval_days ?? spec.spec.window_days;
  if (Number.isSafeInteger(bucket) && Number.isSafeInteger(intervalDays)
    && (bucket as number) >= 0 && (intervalDays as number) > 0) {
    return new Date((bucket as number) * (intervalDays as number) * 86_400_000).toISOString();
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function schedulerTick(deps: SchedulerDeps): Promise<SchedulerTickResult> {
  const { db } = deps;
  const actor = deps.systemActor ?? "system:scheduler";
  const now = deps.now ? deps.now() : new Date();
  const created: SchedulerTickResult["created"] = [];

  if ((await effectiveRuntimePause(db)).paused) return { created, dispatched: 0 };

  const configs = (await listCycleConfigs(db)).filter((c) => c.enabled);
  for (const cfg of configs) {
    if ((await effectiveRuntimePause(db, cfg.merchantId)).paused) continue;
    const merchant = await getMerchant(db, cfg.merchantId);
    if (!merchant) continue;
    const dueSpecs = dueCycleTasks(cfg, now);
    const plannerBinding = await getAgentBinding(db, "PLANNER");
    if (plannerBinding && dueSpecs.length > 0) {
      try {
        const deterministicOccurredAt = dueSpecs
          .map((spec) => cycleSpecOccurrenceAt(spec, now))
          .sort()[0]!;
        const planner = await enqueuePlannerTaskIfBound(
          db,
          cfg.merchantId,
          {
            key: `cycle_due:${dueSpecs.map((spec) => spec.key).sort().join("|")}`,
            type: "CYCLE_DUE",
            reason: "周期任务到期",
            occurredAt: deterministicOccurredAt,
            signals: dueSpecs.map((spec) => ({
              candidate_key: spec.key,
              task_type: spec.taskType,
              title: spec.title,
              execution_mode: spec.executionMode,
              required_evidence_types: spec.requiredEvidenceTypes,
              priority: spec.priority,
              execution_spec: spec.spec,
            })),
          },
          actor,
        );
        if (planner && !planner.replayed) {
          created.push({
            task_id: planner.task.id,
            key: `planner:${planner.task.id}`,
            task_type: "PLANNER",
            merchant_id: cfg.merchantId,
          });
        }
      } catch (err) {
        deps.log?.(`scheduler: planner trigger for ${cfg.merchantId} failed`, err);
      }
      continue;
    }
    for (const spec of dueSpecs) {
      try {
        const existing = await findTaskByIdempotencyKey(db, spec.key);
        let task = existing;
        if (!task) {
          const res = await createTask(
            db,
            {
              merchant_id: cfg.merchantId,
              definition: {
                title: spec.title,
                task_type: spec.taskType,
                source: "CYCLE",
                priority: spec.priority,
                impact: "MEDIUM",
                execution_spec: JSON.stringify(spec.spec),
                required_evidence_types: spec.requiredEvidenceTypes,
                execution_mode: spec.executionMode,
              },
              idempotency_key: spec.key,
            },
            actor,
          );
          task = res.task;
          if (!res.replayed) {
            created.push({
              task_id: task.id, key: spec.key,
              task_type: spec.taskType, merchant_id: cfg.merchantId,
            });
          }
        }
        // 崩溃恢复安全：授权步骤幂等，已授权/已推进的任务是 no-op。
        await authorizeReadOnlyTask(db, task, actor, "周期配置预授权（Ⓐ级只读任务自动运行）");
      } catch (err) {
        deps.log?.(`scheduler: cycle task ${spec.key} failed`, err);
      }
    }
  }

  // 派发清扫：所有 APPROVED 的Ⓐ级任务（新授权的 + 失败待重试的 + 采纳的只读建议）尝试自动派发。
  // 绑定未配好的类型直接跳过 —— 不建 attempt、不烧重试预算（配置缺失 ≠ 执行失败）。
  let dispatched = 0;
  const approved = await listTasksByStatus(db, ["APPROVED"]);
  for (const task of approved) {
    if (task.executionMode !== "READ_ONLY" || !AUTO_AUTHORIZABLE_SOURCES.has(task.source)) continue;
    if ((await effectiveRuntimePause(db, task.merchantId)).paused) continue;
    try {
      const binding = await getAgentBinding(db, dispatchBindingKey(task.taskType));
      if (!binding) {
        deps.log?.(`scheduler: skip dispatch ${task.id} — no agent bound for ${dispatchBindingKey(task.taskType)}`);
        continue;
      }
      const res = await autoDispatch(db, task.id, actor);
      if (res && !res.replayed) dispatched += 1;
    } catch (err) {
      deps.log?.(`scheduler: auto-dispatch ${task.id} failed`, err);
    }
  }

  return { created, dispatched };
}

/** 定时器包装：与 ExecutionWorker 同构（start/stop/tickOnce）。 */
export class CycleScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly intervalMs = 60_000,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tickOnce();
    this.timer = setInterval(() => void this.tickOnce(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tickOnce(): Promise<SchedulerTickResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await schedulerTick(this.deps);
    } catch (err) {
      this.deps.log?.("scheduler tick failed", err);
      return null;
    } finally {
      this.running = false;
    }
  }
}
