import type { Db } from "../db/connection.js";
import crypto from "node:crypto";
import { CORE_RUN_TERMINAL_STATUSES } from "../domain/enums.js";
import { sha256HashBytes } from "../domain/hashing.js";
import type { Task } from "../repos/taskTypes.js";
import { getTask } from "../repos/taskRepo.js";
import {
  listDispatchingAttempts,
  listOpenUnknownAttempts,
  upsertAttemptDeliverable,
  updateAttempt,
  type ExecutionAttempt,
  type ExecutionAttemptDeliverable,
} from "../repos/executionRepo.js";
import { getAgentBinding } from "../repos/settingsRepo.js";
import { CoreAiError, type CoreAiClient, type CoreAgentRunDetail } from "./coreAiClient.js";
import {
  autoDispatch,
  dispatchBindingKey,
  settleAttemptFailure,
  settleAttemptSuccess,
  settleAttemptUnknown,
} from "./executionService.js";
import { buildPlannerRunInput, ingestPlannerRunOutput } from "./plannerService.js";
import {
  buildQuestionnaireRunInput,
  ingestQuestionnaireRunOutput,
} from "./questionnaireAdapterService.js";
import {
  buildSpecialistRunInput,
  ingestSpecialistRunOutput,
  isStructuredSpecialistTask,
} from "./specialistAdapterService.js";

/** 触发宽限：DISPATCHING 且无 core_run_id 超过此时长，视为触发中断。
 * 只读任务重触发无害；写入类无法排除「请求已到达」→ 结果不明（红线③）。 */
const TRIGGER_GRACE_MS = 60_000;
const MAX_TERMINAL_ARTIFACT_BYTES = 8 * 1024 * 1024;
const TERMINAL_ARTIFACT_HASH_BUDGET_MS = 15_000;

export interface ExecutionWorkerDeps {
  db: Db;
  /** mockMode=true 时可为 null（不打 core-ai）。 */
  client: CoreAiClient | null;
  /** true = 不打 core-ai，本地模拟执行成功（冒烟/演示用）。 */
  mockMode?: boolean;
  systemActor?: string;
  intervalMs?: number;
  /** One shared deadline across all terminal artifact hashes for an attempt. */
  terminalArtifactHashBudgetMs?: number;
  log?: (message: string, err?: unknown) => void;
  now?: () => Date;
}

function isWriteMode(task: Task): boolean {
  return task.executionMode === "AUTO_WRITE";
}

/** 触发请求被服务端「明确拒绝、未执行」的状态码：这些可安全判确认失败。
 * 其余（网络 0 / 408 / 429 / 5xx / 未知）对写入类一律按结果不明处理。 */
const PREFLIGHT_REJECT_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

function isPreflightReject(err: unknown): boolean {
  return err instanceof CoreAiError && PREFLIGHT_REJECT_STATUSES.has(err.status);
}

/** core run 输出里提取发布引用（agent 约定返回 JSON，含 published_ref）。 */
function extractPublishedRef(output: string | null | undefined): string | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const ref = parsed["published_ref"] ?? parsed["publishedRef"] ?? parsed["post_url"];
    return typeof ref === "string" && ref !== "" ? ref : null;
  } catch {
    return null;
  }
}

/** 派发输入：任务的执行定义 + 查证线索号。agent 端拿到的就是「要做什么」的完整包。 */
function buildRunInput(task: Task, attempt: ExecutionAttempt): string {
  let spec: unknown;
  try {
    spec = JSON.parse(task.executionSpec);
  } catch {
    spec = task.executionSpec;
  }
  return JSON.stringify({
    seo_ops_task_id: task.id,
    probe_ref: attempt.probeRef,
    attempt_no: attempt.attemptNo,
    merchant_id: task.merchantId,
    location_id: task.locationId,
    task_type: task.taskType,
    execution_mode: task.executionMode,
    title: task.title,
    execution_spec: spec,
  });
}

/** 顺序处理 DISPATCHING attempts：无 run_id 的触发，有 run_id 的轮询终态并结算。
 * 结算函数全部幂等（attempt id 做幂等键），worker 崩溃重启安全。 */
export class ExecutionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: ExecutionWorkerDeps) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 10_000;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const attempts = await listDispatchingAttempts(this.deps.db);
      for (const attempt of attempts) {
        try {
          await this.processAttempt(attempt);
        } catch (err) {
          this.deps.log?.(`execution worker: attempt ${attempt.id} processing failed`, err);
        }
      }
    } catch (err) {
      this.deps.log?.("execution worker: poll failed", err);
    } finally {
      this.running = false;
    }
  }

  private actor(): string {
    return this.deps.systemActor ?? "system:executor";
  }

  /** Preserve only bounded terminal references. Artifact bytes are streamed
   * solely to compute a stable hash and are never retained in SEO Ops. */
  private async persistTerminalReferences(
    attempt: ExecutionAttempt,
    core: CoreAgentRunDetail,
  ): Promise<ExecutionAttempt> {
    const now = new Date().toISOString();
    const persisted = { ...attempt, traceRef: core.trace_id ?? attempt.traceRef, updatedAt: now };
    const deliverables: ExecutionAttemptDeliverable[] = [];
    const hashBudgetSignal = AbortSignal.timeout(
      this.deps.terminalArtifactHashBudgetMs ?? TERMINAL_ARTIFACT_HASH_BUDGET_MS,
    );
    for (const artifact of (core.artifacts ?? []).slice(0, 20)) {
      let sha256: string | null = null;
      const declaredSizeIsSafe = artifact.size === undefined
        || artifact.size === null
        || (Number.isSafeInteger(artifact.size)
          && artifact.size >= 0
          && artifact.size <= MAX_TERMINAL_ARTIFACT_BYTES);
      if (declaredSizeIsSafe && !hashBudgetSignal.aborted) {
        try {
          sha256 = sha256HashBytes(await this.deps.client!.downloadArtifact(
            artifact.download_url,
            { maxBytes: MAX_TERMINAL_ARTIFACT_BYTES, signal: hashBudgetSignal },
          ));
        } catch {
          this.deps.log?.(`execution worker: could not hash terminal artifact ${artifact.file_id}`);
        }
      }
      deliverables.push({
        id: crypto.randomUUID(), attemptId: attempt.id, fileId: artifact.file_id,
        fileName: artifact.file_name, contentType: artifact.content_type ?? null,
        sha256, sourceRef: null, createdAt: now,
      });
    }
    await this.deps.db.withTransaction(async (tx) => {
      await updateAttempt(tx, persisted);
      for (const deliverable of deliverables) await upsertAttemptDeliverable(tx, deliverable);
    });
    return persisted;
  }

  private async processAttempt(attempt: ExecutionAttempt): Promise<void> {
    const task = await getTask(this.deps.db, attempt.taskId);
    if (!task) {
      await updateAttempt(this.deps.db, {
        ...attempt,
        status: "FAILED_CONFIRMED",
        error: "task record missing",
        resolvedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    if (task.executionMode === "AUTO_WRITE"
      && (task.taskType === "GBP_POST" || task.taskType === "GBP_UPDATE")) {
      // Command-bound rows are excluded by the repository query. Any new GBP
      // write reaching the generic queue is therefore a legacy/invalid row and
      // must be terminalized before an Agent binding or Core client is read.
      await settleAttemptFailure(
        this.deps.db,
        attempt,
        "GBP_DEDICATED_COMMAND_REQUIRED",
        this.actor(),
      );
      return;
    }
    if (attempt.coreRunId === null) {
      await this.dispatchAttempt(attempt, task);
    } else {
      await this.pollAttempt(attempt, task);
    }
  }

  private async dispatchAttempt(attempt: ExecutionAttempt, task: Task): Promise<void> {
    const { db } = this.deps;

    // 红线③：商户执行链冻结时不发起任何新触发（同一 tick 内前一条判为
    // 结果不明后，后面的在途 attempt 也必须停下）。已冻结 → 原地停靠，
    // 查证解冻后下个 tick 继续。
    const frozen = await listOpenUnknownAttempts(db, task.merchantId);
    if (frozen.length > 0 && !frozen.some((f) => f.id === attempt.id)) {
      return;
    }

    if (this.deps.mockMode) {
      // 冒烟模式：立即视为执行成功；写入类给一个可核验的 mock 引用。
      const mockRunId = `mock-${attempt.id}`;
      const settled: ExecutionAttempt = { ...attempt, coreRunId: mockRunId };
      await updateAttempt(db, { ...settled, updatedAt: new Date().toISOString() });
      const ref = isWriteMode(task) || task.executionMode === "ARTIFACT"
        ? `mock:${attempt.probeRef}`
        : null;
      await settleAttemptSuccess(db, settled, ref, this.actor());
      return;
    }

    // 触发中断裁决（写入类）：上一进程可能在标记之后、run_id 落库之前崩溃 ——
    // 请求可能已发出，无法排除已执行 → 结果不明，绝不重触发（红线③）。
    if (isWriteMode(task) && attempt.triggerStartedAt !== null) {
      await settleAttemptUnknown(
        db,
        attempt,
        "TRIGGER_INTERRUPTED: a prior trigger may have been sent (marker present, no run id)",
        this.actor(),
      );
      return;
    }
    // 兜底（迁移前的老行没有标记）：超过宽限窗仍无 run_id 的写入类，同样判结果不明。
    const nowMs = (this.deps.now ? this.deps.now() : new Date()).getTime();
    const ageMs = nowMs - Date.parse(attempt.startedAt);
    if (ageMs > TRIGGER_GRACE_MS && isWriteMode(task)) {
      await settleAttemptUnknown(
        db,
        attempt,
        "TRIGGER_INTERRUPTED: dispatch window expired before core run id was recorded",
        this.actor(),
      );
      return;
    }

    const bindingKey = dispatchBindingKey(task.taskType);
    const binding = await getAgentBinding(db, bindingKey);
    if (!binding) {
      // 配置缺失 ≠ 执行失败：不烧重试预算，原地停靠等绑定补齐（设置页可见「未绑定」）。
      this.deps.log?.(`execution worker: attempt ${attempt.id} parked — no agent bound for ${bindingKey}`);
      return;
    }

    const client = this.deps.client;
    if (!client) return;

    // 写入类：先落触发标记再发请求。崩溃在标记后任何位置 → 重启见标记判结果不明。
    let current = attempt;
    if (isWriteMode(task)) {
      current = { ...attempt, triggerStartedAt: new Date().toISOString() };
      await updateAttempt(db, { ...current, updatedAt: new Date().toISOString() });
    }
    try {
      const input = task.taskType === "PLANNER"
        ? await buildPlannerRunInput(db, task, current)
        : task.taskType === "QUESTIONNAIRE"
          ? await buildQuestionnaireRunInput(db, task, current)
          : isStructuredSpecialistTask(task.taskType)
            ? await buildSpecialistRunInput(db, task, current)
          : buildRunInput(task, current);
      const res = await client.trigger(binding.agentId, input);
      await updateAttempt(db, {
        ...current,
        coreRunId: res.run_id,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (isWriteMode(task) && !isPreflightReject(err)) {
        // 网络失败 / 5xx / 超时类：请求可能已到达 core-ai → 结果不明，冻结待查证。
        const message = err instanceof Error ? err.message : "trigger failed";
        await settleAttemptUnknown(db, current, `trigger failure (outcome uncertain): ${message}`, this.actor());
        return;
      }
      // 明确的服务端拒绝（400/401/403/404/409/422）：请求未被执行，确认失败。
      const message = err instanceof Error ? err.message : "trigger failed";
      const { retryEligible } = await settleAttemptFailure(db, current, message, this.actor());
      if (retryEligible) await autoDispatch(db, task.id, this.actor());
    }
  }

  private async pollAttempt(attempt: ExecutionAttempt, task: Task): Promise<void> {
    const { db, client } = this.deps;
    const runId = attempt.coreRunId as string;
    if (!client) return;

    let core;
    try {
      core = await client.getRun(runId);
    } catch (err) {
      if (err instanceof CoreAiError && err.status === 404) {
        // run 消失：写入类结果不明；只读确认失败可重试。
        if (isWriteMode(task)) {
          await settleAttemptUnknown(db, attempt, "core run not found", this.actor());
        } else {
          const { retryEligible } = await settleAttemptFailure(
            db, attempt, "core run not found", this.actor());
          if (retryEligible) await autoDispatch(db, task.id, this.actor());
        }
        return;
      }
      // 网络/5xx：瞬态，下个 tick 再查（run 状态是事实源，不急于裁决）。
      this.deps.log?.(`execution worker: getRun ${runId} transient failure`, err);
      return;
    }

    if (!(CORE_RUN_TERMINAL_STATUSES as readonly string[]).includes(core.status)) return;
    const terminalAttempt = await this.persistTerminalReferences(attempt, core);

    if (core.status === "COMPLETED") {
      if (task.taskType === "PLANNER") {
        try {
          await ingestPlannerRunOutput(db, task, runId, core.output, this.actor());
        } catch (err) {
          const message = err instanceof Error ? err.message : "planner output ingestion failed";
          const { retryEligible } = await settleAttemptFailure(db, terminalAttempt, message, this.actor());
          if (retryEligible) await autoDispatch(db, task.id, this.actor());
          return;
        }
      }
      if (task.taskType === "QUESTIONNAIRE") {
        try {
          await ingestQuestionnaireRunOutput(db, task, runId, core.output, this.actor());
        } catch (err) {
          const message = err instanceof Error ? err.message : "questionnaire output ingestion failed";
          const { retryEligible } = await settleAttemptFailure(db, terminalAttempt, message, this.actor());
          if (retryEligible) await autoDispatch(db, task.id, this.actor());
          return;
        }
      }
      if (isStructuredSpecialistTask(task.taskType)) {
        try {
          await ingestSpecialistRunOutput(db, task, runId, core.output, this.actor());
        } catch (err) {
          const message = err instanceof Error ? err.message : "specialist output ingestion failed";
          const { retryEligible } = await settleAttemptFailure(db, terminalAttempt, message, this.actor());
          if (retryEligible) await autoDispatch(db, task.id, this.actor());
          return;
        }
      }
      await settleAttemptSuccess(db, terminalAttempt, extractPublishedRef(core.output), this.actor());
      return;
    }

    if (core.status === "FAILED") {
      // agent 明确报告失败 = 确认失败（动作没发生由 agent 语义保证）。
      const { retryEligible } = await settleAttemptFailure(
        db, terminalAttempt, core.error ?? "core run FAILED", this.actor());
      if (retryEligible) await autoDispatch(db, task.id, this.actor());
      return;
    }

    // TIMEOUT / CANCELLED：写入类动作可能已发生 → 结果不明；只读/成品类确认失败。
    if (isWriteMode(task)) {
      await settleAttemptUnknown(db, terminalAttempt, `core run ${core.status}`, this.actor());
    } else {
      const { retryEligible } = await settleAttemptFailure(
        db, terminalAttempt, `core run ${core.status}`, this.actor());
      if (retryEligible) await autoDispatch(db, task.id, this.actor());
    }
  }
}
