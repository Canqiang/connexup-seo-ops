import crypto from "node:crypto";
import type { Db } from "../db/connection.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { requestFingerprint } from "../domain/hashing.js";
import {
  canConfirmExecution,
  canVerify,
  resolveOutcome as resolveOutcomeTransition,
  statusAfterAttemptSuccess,
} from "../domain/stateMachine.js";
import {
  OUTCOME_RESOLUTIONS,
  READ_ONLY_AUTO_RETRY_LIMIT,
  type OutcomeResolution,
} from "../domain/enums.js";
import { getLocation } from "../repos/locationRepo.js";
import { getTask } from "../repos/taskRepo.js";
import type { Task } from "../repos/taskTypes.js";
import {
  getAttempt,
  insertAttempt,
  listAttemptsByTask,
  listInFlightAttempts,
  listOpenUnknownAttempts,
  updateAttempt,
  type ExecutionAttempt,
} from "../repos/executionRepo.js";
import { getCapability } from "../repos/settingsRepo.js";
import { buildEvent, mutateTask, mutateTaskRetry } from "./taskService.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** 发布后核验期限：+7 天（设计约定，可后续入周期配置）。 */
const VERIFY_WINDOW_DAYS = 7;

export function verifyDueFrom(publishedAtIso: string): string {
  const due = new Date(Date.parse(publishedAtIso) + VERIFY_WINDOW_DAYS * 24 * 3600 * 1000);
  return due.toISOString();
}

/** 写入类任务需要的能力（能力矩阵键）；null = 无需外部资产。 */
export function requiredCapabilityFor(taskType: string, executionMode: string): string | null {
  if (executionMode !== "AUTO_WRITE") return null;
  if (taskType === "GBP_POST" || taskType === "GBP_UPDATE") return "GBP_WRITE";
  if (taskType === "WEBSITE_CONTENT") return "WEBSITE_WRITE";
  return null;
}

/** 派发（执行）用的 agent 绑定键：GBP 写入类任务由 GBP_EXECUTION agent 执行；
 * 其余任务的执行 agent 就绑在自己的 task_type 上。内容生成 agent（如
 * GBP_POST 的文案）绑在 task_type 本身，与派发键区分开。 */
export function dispatchBindingKey(taskType: string): string {
  if (taskType === "GBP_POST" || taskType === "GBP_UPDATE") return "GBP_EXECUTION";
  return taskType;
}

export interface GateCheck {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
}

async function unfinishedDependencies(db: Db, task: Task): Promise<Array<Task | null>> {
  const dependencies = await Promise.all(task.dependsOnTaskIds.map((id) => getTask(db, id)));
  return dependencies.filter((dependency) => !dependency || dependency.status !== "DONE");
}

/** 门 2 服务端校验（同事务复核）。任何一项不过则拒绝执行确认。 */
export async function gateChecks(db: Db, task: Task): Promise<GateCheck[]> {
  const checks: GateCheck[] = [];

  const unfinished = await unfinishedDependencies(db, task);
  checks.push({
    key: "dependencies_done",
    label: "上游任务已完成",
    passed: unfinished.length === 0,
    detail: unfinished.length === 0
      ? "通过"
      : `${unfinished.length}/${task.dependsOnTaskIds.length} 个依赖尚未完成`,
  });

  // 1. rev/hash 与审批一致
  const lastApprove = [...task.approvalDecisions]
    .reverse()
    .find((d) => d.decision === "APPROVE");
  const revMatch =
    !!lastApprove &&
    lastApprove.taskRevision === task.taskRevision &&
    lastApprove.executionSpecHash === task.executionSpecHash;
  checks.push({
    key: "rev_hash_matches_approval",
    label: "rev / hash 与审批一致",
    passed: revMatch,
    detail: lastApprove
      ? `rev ${task.taskRevision} · ${task.executionSpecHash.slice(0, 8)}…`
      : "无审批记录",
  });

  // 2. 审批仍然有效（未撤销：当前状态即门 1 结论）
  const approvalValid = task.status === "APPROVED";
  checks.push({
    key: "approval_valid",
    label: "审批仍然有效（未撤销 · 未过期）",
    passed: approvalValid,
    detail: `当前状态 ${task.status}`,
  });

  // 3. 资产授权有效（能力矩阵）
  const requiredCapability = requiredCapabilityFor(task.taskType, task.executionMode);
  let capabilityPassed = true;
  let capabilityDetail = "无需外部资产";
  if (requiredCapability) {
    const capability = await getCapability(db, task.merchantId, requiredCapability);
    capabilityPassed = capability?.status === "ACTIVE";
    capabilityDetail = capability
      ? `${requiredCapability} · ${capability.status}${capability.verifiedAt ? ` · 核验 ${capability.verifiedAt.slice(0, 10)}` : ""}`
      : `${requiredCapability} · 未接入`;
  }
  checks.push({
    key: "capability_active",
    label: "资产授权有效（能力矩阵）",
    passed: capabilityPassed,
    detail: capabilityDetail,
  });

  // 4. 外部资产 ID 匹配（执行定义 locationName ↔ 地点外部身份）
  let refPassed = true;
  let refDetail = "执行定义未引用外部资产";
  try {
    const spec = JSON.parse(task.executionSpec) as { locationName?: string };
    if (spec.locationName) {
      if (!task.locationId) {
        refPassed = false;
        refDetail = "执行定义引用 locationName 但任务未绑定地点";
      } else {
        const location = await getLocation(db, task.locationId);
        const external = location?.externalIdentities ?? {};
        const known = Object.values(external);
        refPassed = known.length === 0 ? true : known.includes(spec.locationName);
        refDetail = refPassed
          ? `locationName 匹配（${spec.locationName.slice(0, 40)}）`
          : `locationName 与地点外部身份不一致`;
      }
    }
  } catch {
    refPassed = false;
    refDetail = "执行定义不是合法 JSON";
  }
  checks.push({
    key: "external_ref_matches",
    label: "locationName 与外部资产 ID 匹配",
    passed: refPassed,
    detail: refDetail,
  });

  // 5. 无在途 attempt，且该商户没有未决的结果待查（冻结面，红线③）
  const inFlight = await listInFlightAttempts(db, task.id);
  const frozen = await listOpenUnknownAttempts(db, task.merchantId);
  const clear = inFlight.length === 0 && frozen.length === 0;
  checks.push({
    key: "no_inflight_attempt",
    label: "无在途 attempt / 商户执行链未冻结",
    passed: clear,
    detail: frozen.length > 0
      ? `商户有 ${frozen.length} 个结果待查未决（查证前冻结）`
      : inFlight.length > 0
        ? `attempt#${inFlight[0]!.attemptNo} 在途`
        : "通过",
  });

  return checks;
}

export interface ExecutionPreview {
  confirmable: boolean;
  checks: GateCheck[];
  attempt_count: number;
  gate_ready_status: boolean;
}

export async function executionPreview(db: Db, taskId: string): Promise<ExecutionPreview> {
  const task = await getTask(db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  if (task.executionMode === "MANUAL") {
    throw conflict("manual tasks require explicit human completion evidence", "MANUAL_EXECUTION_ONLY");
  }
  const checks = await gateChecks(db, task);
  const statusOk = canConfirmExecution(task.status);
  return {
    confirmable: statusOk && checks.every((c) => c.passed),
    checks,
    attempt_count: task.attemptCount,
    gate_ready_status: statusOk,
  };
}

function probeRef(task: Task, attemptNo: number): string {
  return `exec-${task.id.slice(0, 8)}-rev${task.taskRevision}-attempt${attemptNo}`;
}

async function createAttemptInTx(
  tx: Db,
  task: Task,
  gate: "G2" | "AUTO",
): Promise<ExecutionAttempt> {
  const now = nowIso();
  const attempt: ExecutionAttempt = {
    id: crypto.randomUUID(),
    taskId: task.id,
    merchantId: task.merchantId,
    attemptNo: task.attemptCount + 1,
    status: "DISPATCHING",
    gate,
    agentRunId: null,
    coreRunId: null,
    traceRef: null,
    probeRef: probeRef(task, task.attemptCount + 1),
    error: null,
    startedAt: now,
    triggerStartedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    resolutionNote: null,
    createdAt: now,
    updatedAt: now,
  };
  await insertAttempt(tx, attempt);
  return attempt;
}

export interface ConfirmExecutionInput {
  expected_state_version: number;
  idempotency_key: string;
}

/** 门 2：独立人工动作。全部校验在同一事务内复核后创建 attempt 并转 DISPATCHING。 */
export async function confirmExecution(
  db: Db,
  taskId: string,
  input: ConfirmExecutionInput,
  actorId: string,
): Promise<{ task: Task; replayed: boolean }> {
  const fingerprint = requestFingerprint({ action: "CONFIRM_EXECUTION" });
  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    async (task, tx) => {
      if (task.executionMode === "MANUAL") {
        throw conflict("manual tasks require explicit human completion evidence", "MANUAL_EXECUTION_ONLY");
      }
      if (!canConfirmExecution(task.status)) {
        throw conflict(
          `cannot confirm execution in status ${task.status}`,
          "INVALID_TRANSITION",
        );
      }
      const checks = await gateChecks(tx, task);
      const failed = checks.filter((c) => !c.passed);
      if (failed.length > 0) {
        throw conflict(
          `gate-2 checks failed: ${failed.map((c) => c.key).join(", ")}`,
          "GATE2_CHECK_FAILED",
        );
      }
      const attempt = await createAttemptInTx(tx, task, "G2");
      const v1 = task.stateVersion + 1;
      const updated: Task = {
        ...task,
        status: "DISPATCHING",
        attemptCount: attempt.attemptNo,
        stateVersion: v1,
        updatedAt: nowIso(),
        events: [
          ...task.events,
          buildEvent("EXECUTION_CONFIRMED", task.taskRevision, v1, actorId, {
            fromStatus: task.status,
            toStatus: "EXECUTION_CONFIRMED",
            referenceId: attempt.id,
          }),
          buildEvent("ATTEMPT_DISPATCHING", task.taskRevision, v1, actorId, {
            fromStatus: "EXECUTION_CONFIRMED",
            toStatus: "DISPATCHING",
            referenceId: attempt.id,
          }),
        ],
      };
      return updated;
    },
  );
}

export interface CompleteManualInput {
  source_ref: string;
  note?: string;
  expected_state_version: number;
  idempotency_key: string;
}

/** Manual work has no system attempt. A human with execute permission records
 * a concrete external evidence reference and the independently readback task
 * becomes DONE in the same CAS mutation. */
export async function completeManualTask(
  db: Db,
  taskId: string,
  input: CompleteManualInput,
  actorId: string,
): Promise<{ task: Task; replayed: boolean }> {
  if (!input.source_ref.trim()) throw badRequest("source_ref is required");
  const fingerprint = requestFingerprint({ action: "MANUAL_COMPLETE", source_ref: input.source_ref, note: input.note ?? null });
  return mutateTask(db, taskId, input.idempotency_key, fingerprint, input.expected_state_version,
    async (task) => {
      if (task.executionMode !== "MANUAL" || task.status !== "APPROVED") {
        throw conflict(`cannot complete manual task in ${task.status}/${task.executionMode}`, "INVALID_TRANSITION");
      }
      const now = nowIso();
      const evidence = {
        id: crypto.randomUUID(), taskRevision: task.taskRevision, type: "MANUAL_COMPLETION",
        sourceRef: input.source_ref.trim(), capturedAt: now, verificationStatus: "VERIFIED" as const,
        requirementKey: "MANUAL_COMPLETION", createdBy: actorId, createdAt: now,
      };
      const version = task.stateVersion + 1;
      return {
        ...task, status: "DONE", evidenceRefs: [...task.evidenceRefs, evidence],
        stateVersion: version, updatedAt: now,
        events: [...task.events, buildEvent("MANUAL_COMPLETED", task.taskRevision, version, actorId, {
          fromStatus: task.status, toStatus: "DONE", referenceId: evidence.id,
        })],
      };
    });
}

/** Ⓐ 级自动派发（scheduler 用）：规则预授权，跳过门 2 人工确认；仍要求
 * APPROVED 状态与商户未冻结。 */
export async function autoDispatch(
  db: Db,
  taskId: string,
  systemActor: string,
): Promise<{ task: Task; replayed: boolean } | null> {
  const current = await getTask(db, taskId);
  if (!current) return null;
  if (current.status !== "APPROVED" || current.executionMode !== "READ_ONLY") return null;
  if ((await unfinishedDependencies(db, current)).length > 0) return null;
  const frozen = await listOpenUnknownAttempts(db, current.merchantId);
  if (frozen.length > 0) return null;
  const inFlight = await listInFlightAttempts(db, current.id);
  if (inFlight.length > 0) return null;

  const key = `auto-dispatch:${taskId}:attempt${current.attemptCount + 1}`;
  const fingerprint = requestFingerprint({ action: "AUTO_DISPATCH", attempt: current.attemptCount + 1 });
  return mutateTaskRetry(db, taskId, key, fingerprint, async (task, tx) => {
    if (task.status !== "APPROVED") {
      throw conflict(`task moved to ${task.status}`, "INVALID_TRANSITION");
    }
    if ((await unfinishedDependencies(tx, task)).length > 0) {
      throw conflict("task dependencies are not DONE", "TASK_DEPENDENCY_NOT_DONE");
    }
    const attempt = await createAttemptInTx(tx, task, "AUTO");
    const v1 = task.stateVersion + 1;
    return {
      ...task,
      status: "DISPATCHING",
      attemptCount: attempt.attemptNo,
      stateVersion: v1,
      updatedAt: nowIso(),
      events: [
        ...task.events,
        buildEvent("ATTEMPT_DISPATCHING", task.taskRevision, v1, systemActor, {
          fromStatus: task.status,
          toStatus: "DISPATCHING",
          referenceId: attempt.id,
        }),
      ],
    };
  });
}

/** attempt 成功：写入/成品 → PENDING_VERIFY（核验期限 +7 天）；只读 → DONE。
 * attempt 行更新在任务事务内完成 —— 两笔写要么都落，要么都不落；
 * 崩溃重放时 attempt 仍是 DISPATCHING，worker 会重新裁决（红线②的崩溃安全）。 */
export async function settleAttemptSuccess(
  db: Db,
  attempt: ExecutionAttempt,
  publishedRef: string | null,
  systemActor: string,
): Promise<void> {
  const now = nowIso();
  await mutateTaskRetry(
    db,
    attempt.taskId,
    `attempt-success:${attempt.id}`,
    requestFingerprint({ attempt: attempt.id, outcome: "SUCCEEDED" }),
    async (task, tx) => {
      await updateAttempt(tx, { ...attempt, status: "SUCCEEDED", resolvedAt: now, updatedAt: now });
      const toStatus = statusAfterAttemptSuccess(task.executionMode);
      const v1 = task.stateVersion + 1;
      const published = task.executionMode === "READ_ONLY" ? {} : {
        publishedRef: publishedRef ?? task.publishedRef,
        publishedAt: now,
        verifyDueAt: verifyDueFrom(now),
      };
      return {
        ...task,
        ...published,
        status: toStatus,
        stateVersion: v1,
        updatedAt: now,
        events: [
          ...task.events,
          buildEvent("EXECUTION_SUCCEEDED", task.taskRevision, v1, systemActor, {
            fromStatus: task.status,
            toStatus,
            referenceId: attempt.id,
          }),
        ],
      };
    },
  );
}

/** attempt 确认失败：任务回 APPROVED；只读Ⓐ自动重试超上限则 FAILED 升级人工。
 * 重试预算只数 AUTO 门的失败（人工 G2 确认失败不烧自动预算）：
 * 初次自动 + 至多 READ_ONLY_AUTO_RETRY_LIMIT 次自动重试。
 * attempt 行更新在任务事务内完成（崩溃原子性同 settleAttemptSuccess）。 */
export async function settleAttemptFailure(
  db: Db,
  attempt: ExecutionAttempt,
  error: string,
  systemActor: string,
): Promise<{ retryEligible: boolean }> {
  const now = nowIso();
  let retryEligible = false;
  await mutateTaskRetry(
    db,
    attempt.taskId,
    `attempt-failure:${attempt.id}`,
    requestFingerprint({ attempt: attempt.id, outcome: "FAILED_CONFIRMED" }),
    async (task, tx) => {
      await updateAttempt(tx, {
        ...attempt,
        status: "FAILED_CONFIRMED",
        error,
        resolvedAt: now,
        updatedAt: now,
      });
      const isAutoReadOnly = task.executionMode === "READ_ONLY" && attempt.gate === "AUTO";
      // 同一事务内读回：含刚更新的当前 attempt。
      const autoFailures = (await listAttemptsByTask(tx, task.id, task.merchantId))
        .filter((a) => a.gate === "AUTO" && a.status === "FAILED_CONFIRMED").length;
      const exhausted = isAutoReadOnly && autoFailures >= 1 + READ_ONLY_AUTO_RETRY_LIMIT;
      retryEligible = isAutoReadOnly && !exhausted;
      const toStatus = exhausted ? "FAILED" as const : "APPROVED" as const;
      const v1 = task.stateVersion + 1;
      return {
        ...task,
        status: toStatus,
        stateVersion: v1,
        updatedAt: now,
        events: [
          ...task.events,
          buildEvent("EXECUTION_FAILED", task.taskRevision, v1, systemActor, {
            fromStatus: task.status,
            toStatus,
            referenceId: attempt.id,
          }),
        ],
      };
    },
  );
  return { retryEligible };
}

/** attempt 结果不明：任务 OUTCOME_UNKNOWN，冻结（该商户执行确认全局禁用）。
 * attempt 行更新在任务事务内完成（崩溃原子性同 settleAttemptSuccess）。 */
export async function settleAttemptUnknown(
  db: Db,
  attempt: ExecutionAttempt,
  error: string,
  systemActor: string,
): Promise<void> {
  const now = nowIso();
  await mutateTaskRetry(
    db,
    attempt.taskId,
    `attempt-unknown:${attempt.id}`,
    requestFingerprint({ attempt: attempt.id, outcome: "OUTCOME_UNKNOWN" }),
    async (task, tx) => {
      await updateAttempt(tx, { ...attempt, status: "OUTCOME_UNKNOWN", error, updatedAt: now });
      const v1 = task.stateVersion + 1;
      return {
        ...task,
        status: "OUTCOME_UNKNOWN",
        stateVersion: v1,
        updatedAt: now,
        events: [
          ...task.events,
          buildEvent("OUTCOME_UNKNOWN", task.taskRevision, v1, systemActor, {
            fromStatus: task.status,
            toStatus: "OUTCOME_UNKNOWN",
            referenceId: attempt.id,
          }),
        ],
      };
    },
  );
}

export interface ResolveOutcomeInput {
  resolution: string;
  note?: string;
  published_ref?: string;
  expected_state_version: number;
  idempotency_key: string;
}

/** 查证：人工二选一（发生了 / 没发生），等权重；答案落 attempt + 任务事件。 */
export async function resolveAttemptOutcome(
  db: Db,
  taskId: string,
  attemptId: string,
  input: ResolveOutcomeInput,
  actorId: string,
): Promise<{ task: Task; replayed: boolean }> {
  if (!OUTCOME_RESOLUTIONS.includes(input.resolution as OutcomeResolution)) {
    throw badRequest(`resolution must be one of ${OUTCOME_RESOLUTIONS.join("/")}`);
  }
  const resolution = input.resolution as OutcomeResolution;
  const fingerprint = requestFingerprint({
    attempt: attemptId,
    resolution,
    note: input.note ?? null,
  });
  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    async (task, tx) => {
      const attempt = await getAttempt(tx, attemptId);
      if (!attempt || attempt.taskId !== task.id) {
        throw notFound(`attempt ${attemptId} not found on task ${taskId}`);
      }
      if (attempt.status !== "OUTCOME_UNKNOWN") {
        throw conflict(
          `attempt ${attempt.attemptNo} is not awaiting查证 (status ${attempt.status})`,
          "INVALID_TRANSITION",
        );
      }
      const now = nowIso();
      const { attemptStatus, taskStatus } = resolveOutcomeTransition(
        resolution,
        task.executionMode,
      );
      await updateAttempt(tx, {
        ...attempt,
        status: attemptStatus,
        resolvedAt: now,
        resolvedBy: actorId,
        resolution,
        resolutionNote: input.note ?? null,
        updatedAt: now,
      });
      const v1 = task.stateVersion + 1;
      const published = resolution === "HAPPENED" && task.executionMode !== "READ_ONLY"
        ? {
            publishedRef: input.published_ref ?? task.publishedRef,
            publishedAt: task.publishedAt ?? now,
            verifyDueAt: task.verifyDueAt ?? verifyDueFrom(now),
          }
        : {};
      return {
        ...task,
        ...published,
        status: taskStatus,
        stateVersion: v1,
        updatedAt: now,
        events: [
          ...task.events,
          buildEvent(
            resolution === "HAPPENED" ? "OUTCOME_RESOLVED_HAPPENED" : "OUTCOME_RESOLVED_NOT_HAPPENED",
            task.taskRevision,
            v1,
            actorId,
            { fromStatus: task.status, toStatus: taskStatus, referenceId: attempt.id },
          ),
        ],
      };
    },
  );
}

export interface VerifyInput {
  note?: string;
  published_ref?: string;
  expected_state_version: number;
  idempotency_key: string;
}

/** 核验：已发布的变更公开生效（发布 ≠ 验证）。通过后 VERIFIED → DONE。 */
export async function markVerified(
  db: Db,
  taskId: string,
  input: VerifyInput,
  actorId: string,
): Promise<{ task: Task; replayed: boolean }> {
  const fingerprint = requestFingerprint({
    action: "VERIFY",
    note: input.note ?? null,
    published_ref: input.published_ref ?? null,
  });
  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    (task) => {
      if (!canVerify(task.status)) {
        throw conflict(`cannot verify a task in status ${task.status}`, "INVALID_TRANSITION");
      }
      const now = nowIso();
      const v1 = task.stateVersion + 1;
      return {
        ...task,
        status: "DONE",
        publishedRef: input.published_ref ?? task.publishedRef,
        verifiedAt: now,
        verifiedBy: actorId,
        stateVersion: v1,
        updatedAt: now,
        events: [
          ...task.events,
          buildEvent("VERIFIED", task.taskRevision, v1, actorId, {
            fromStatus: task.status,
            toStatus: "VERIFIED",
          }),
          buildEvent("TASK_DONE", task.taskRevision, v1, actorId, {
            fromStatus: "VERIFIED",
            toStatus: "DONE",
          }),
        ],
      };
    },
  );
}

export async function attemptsView(
  db: Db,
  taskId: string,
  merchantId: string,
): Promise<ExecutionAttempt[]> {
  return listAttemptsByTask(db, taskId, merchantId);
}

export interface ResetFailedInput {
  note?: string;
  expected_state_version: number;
  idempotency_key: string;
}

/** FAILED（自动重试耗尽升级人工）的人工出口：排障后重置回 APPROVED，
 * 重新进入派发清扫。这是显式人工动作，不破坏「禁止自动重试」红线。 */
export async function resetFailedTask(
  db: Db,
  taskId: string,
  input: ResetFailedInput,
  actorId: string,
): Promise<{ task: Task; replayed: boolean }> {
  const fingerprint = requestFingerprint({ action: "RESET_FAILED", note: input.note ?? null });
  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    (task) => {
      if (task.status !== "FAILED") {
        throw conflict(`only FAILED tasks can be reset (status ${task.status})`, "INVALID_TRANSITION");
      }
      const now = nowIso();
      const v1 = task.stateVersion + 1;
      return {
        ...task,
        status: "APPROVED",
        stateVersion: v1,
        updatedAt: now,
        events: [
          ...task.events,
          buildEvent("FAILED_RESET", task.taskRevision, v1, actorId, {
            fromStatus: task.status,
            toStatus: "APPROVED",
          }),
        ],
      };
    },
  );
}
