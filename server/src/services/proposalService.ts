import crypto from "node:crypto";
import { isUniqueViolation, type Db } from "../db/connection.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { canonicalize, requestFingerprint } from "../domain/hashing.js";
import {
  EXECUTION_MODES,
  isModeAllowedForType,
  PROPOSAL_ORIGINS,
  TASK_IMPACTS,
  TASK_PRIORITIES,
  TASK_TYPES,
  type ProposalOrigin,
  type TaskImpact,
  type TaskPriority,
} from "../domain/enums.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { ensureActiveMerchantCycle } from "../repos/merchantCycleRepo.js";
import { getLocation } from "../repos/locationRepo.js";
import {
  closeBatchIfDecided,
  findBatchByIdempotencyKey,
  getBatch,
  getBatchForUpdate,
  getProposal,
  getProposalBySeq,
  getProposalForUpdate,
  insertBatch,
  insertProposal,
  listBatches,
  listProposalsByBatch,
  setProposalTaskId,
  updateProposalDecisionIf,
  type Proposal,
  type ProposalBatch,
} from "../repos/proposalRepo.js";
import { getAgentBinding, getCapability } from "../repos/settingsRepo.js";
import { autoDispatch, dispatchBindingKey, requiredCapabilityFor } from "./executionService.js";
import { authorizeReadOnlyTask } from "./readOnlyAuthorizationService.js";
import { createTask, type DefinitionInput } from "./taskService.js";
import { requireIdempotencyKey, resolveIdempotentCreate } from "./merchantService.js";

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------- 建议批次创建（Planner / Plan 拆解 / 人工提报共用入口） ----------------

export interface ProposalItemInput {
  title: string;
  task_type: string;
  execution_mode: string;
  executor_agent?: string;
  location_id?: string;
  depends_on?: number[];
  due_at?: string;
  priority: string;
  impact: string;
  acceptance_criteria?: string;
  execution_spec: string;
  required_evidence_types?: string[];
}

export interface CreateBatchInput {
  merchant_id: string;
  origin: string;
  trigger_reason?: string;
  planner_run_id?: string;
  snapshot_note?: string;
  idempotency_key: string;
  items: ProposalItemInput[];
}

/** 单条建议的机器校验：失败原因写进 validationFailures（红线：坏建议只能退回，不能采纳）。
 * 校验在批次创建时做一次；采纳时对能力/绑定再做一次（状态可能已变化）。 */
async function validateItem(
  db: Db,
  merchantId: string,
  item: ProposalItemInput,
  allSeqs: Set<number>,
  selfSeq: number,
): Promise<string[]> {
  const failures: string[] = [];

  if (typeof item.title !== "string" || item.title.trim() === "") failures.push("TITLE_EMPTY");
  if (!TASK_TYPES.includes(item.task_type as (typeof TASK_TYPES)[number])) {
    failures.push(`TASK_TYPE_UNKNOWN:${item.task_type}`);
  }
  if (!EXECUTION_MODES.includes(item.execution_mode as (typeof EXECUTION_MODES)[number])) {
    failures.push(`EXECUTION_MODE_UNKNOWN:${item.execution_mode}`);
  } else if (!isModeAllowedForType(item.task_type, item.execution_mode)) {
    // 红线①机器防线：写入型任务类型标成 READ_ONLY 会绕过双门直达写入 agent。
    failures.push(`MODE_NOT_ALLOWED:${item.task_type}:${item.execution_mode}`);
  }
  if (!TASK_PRIORITIES.includes(item.priority as TaskPriority)) failures.push("PRIORITY_INVALID");
  if (!TASK_IMPACTS.includes(item.impact as TaskImpact)) failures.push("IMPACT_INVALID");

  for (const dep of item.depends_on ?? []) {
    if (dep === selfSeq) failures.push(`DEPENDS_SELF:${dep}`);
    else if (!allSeqs.has(dep)) failures.push(`DEPENDS_MISSING:${dep}`);
  }

  if (item.due_at !== undefined) {
    if (Number.isNaN(Date.parse(item.due_at))) failures.push("DUE_INVALID");
  }

  try {
    canonicalize(item.execution_spec);
  } catch {
    failures.push("SPEC_INVALID");
  }

  if (item.location_id !== undefined) {
    const location = await getLocation(db, item.location_id);
    if (!location || location.merchantId !== merchantId) failures.push("LOCATION_INVALID");
  }

  // 写入类建议：能力矩阵必须 ACTIVE 才可被采纳。
  const cap = requiredCapabilityFor(item.task_type, item.execution_mode);
  if (cap) {
    const record = await getCapability(db, merchantId, cap);
    if (!record) failures.push(`CAPABILITY_MISSING:${cap}`);
    else if (record.status !== "ACTIVE") failures.push(`CAPABILITY_BLOCKED:${cap}`);
  }

  // 非人工任务：必须有执行 agent 绑定，否则派发时必然失败。
  if (item.execution_mode !== "MANUAL") {
    const bindingKey = dispatchBindingKey(item.task_type);
    const binding = await getAgentBinding(db, bindingKey);
    if (!binding) failures.push(`AGENT_NOT_BOUND:${bindingKey}`);
  }

  return failures;
}

export interface BatchWithItems {
  batch: ProposalBatch;
  proposals: Proposal[];
}

export async function createProposalBatch(
  db: Db,
  input: CreateBatchInput,
  actorId: string,
): Promise<{ result: BatchWithItems; replayed: boolean }> {
  // 并发同 key 双创建：唯一索引拦下后来者（23505），重试一次走 replay 路径。
  try {
    return await createProposalBatchOnce(db, input, actorId);
  } catch (error) {
    if (isUniqueViolation(error)) return createProposalBatchOnce(db, input, actorId);
    throw error;
  }
}

async function createProposalBatchOnce(
  db: Db,
  input: CreateBatchInput,
  actorId: string,
): Promise<{ result: BatchWithItems; replayed: boolean }> {
  const key = requireIdempotencyKey(input.idempotency_key, "idempotency_key");
  if (!PROPOSAL_ORIGINS.includes(input.origin as ProposalOrigin)) {
    throw badRequest(`origin must be one of ${PROPOSAL_ORIGINS.join("/")}`);
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw badRequest("items must be a non-empty array");
  }
  if (input.items.length > 50) throw badRequest("items must contain at most 50 entries");

  const fingerprint = requestFingerprint({
    merchant_id: input.merchant_id,
    origin: input.origin,
    items: input.items,
  });

  return db.withTransaction(async (tx) => {
    const existing = await findBatchByIdempotencyKey(tx, key);
    const replay = resolveIdempotentCreate(existing, fingerprint);
    if (replay) {
      return {
        result: { batch: replay, proposals: await listProposalsByBatch(tx, replay.id) },
        replayed: true,
      };
    }

    const merchant = await getMerchant(tx, input.merchant_id);
    if (!merchant) throw notFound(`merchant ${input.merchant_id} not found`);

    const now = nowIso();
    const cycle = await ensureActiveMerchantCycle(tx, merchant.id, now);
    const batch: ProposalBatch = {
      id: crypto.randomUUID(),
      merchantId: merchant.id,
      cycleId: cycle.id,
      origin: input.origin as ProposalOrigin,
      triggerReason: input.trigger_reason ?? null,
      plannerRunId: input.planner_run_id ?? null,
      snapshotNote: input.snapshot_note ?? null,
      status: "OPEN",
      creationIdempotencyKey: key,
      requestFingerprint: fingerprint,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    };
    await insertBatch(tx, batch);

    const allSeqs = new Set(input.items.map((_, i) => i + 1));
    const proposals: Proposal[] = [];
    for (let i = 0; i < input.items.length; i += 1) {
      const item = input.items[i];
      if (!item) continue;
      const seq = i + 1;
      const failures = await validateItem(tx, merchant.id, item, allSeqs, seq);
      const proposal: Proposal = {
        id: crypto.randomUUID(),
        batchId: batch.id,
        merchantId: merchant.id,
        locationId: item.location_id ?? null,
        seq,
        title: item.title ?? "(untitled)",
        taskType: item.task_type,
        executionMode: item.execution_mode,
        executorAgent: item.executor_agent ?? null,
        dependsOn: item.depends_on ?? [],
        dueAt: item.due_at ?? null,
        priority: item.priority,
        impact: item.impact,
        acceptanceCriteria: item.acceptance_criteria ?? null,
        executionSpec: item.execution_spec,
        requiredEvidenceTypes: item.required_evidence_types ?? [],
        validationFailures: failures,
        status: failures.length > 0 ? "VALIDATION_FAILED" : "PENDING",
        decidedBy: null,
        decidedAt: null,
        returnReason: null,
        taskId: null,
        createdAt: now,
        updatedAt: now,
      };
      await insertProposal(tx, proposal);
      proposals.push(proposal);
    }

    return { result: { batch, proposals }, replayed: false };
  });
}

// ---------------- 判定：采纳 → 建 Task；退回 → 留痕 ----------------

export interface DecideProposalInput {
  action: "ADOPT" | "RETURN";
  return_reason?: string;
  /** 采纳时允许人工覆写（AM 判定权）：改优先级/时限后再采纳。 */
  override_priority?: string;
  override_due_at?: string;
}

export interface DecisionResult {
  proposal: Proposal;
  taskId: string | null;
}

export async function decideProposal(
  db: Db,
  proposalId: string,
  input: DecideProposalInput,
  actorId: string,
): Promise<DecisionResult> {
  if (input.action !== "ADOPT" && input.action !== "RETURN") {
    throw badRequest("action must be ADOPT or RETURN");
  }
  if (input.action === "ADOPT") {
    return adoptProposal(db, proposalId, input, actorId);
  }
  return returnProposal(db, proposalId, input, actorId);
}

/** 采纳（两段式，防 ADOPT/RETURN 竞态）：
 * 第一段：行锁事务内校验状态/能力/绑定/依赖，并以 CAS 落 ADOPTED（task_id 暂空）；
 * 第二段：事务外建任务（幂等键 proposal:<id>）→ 回填 task_id。
 * 崩溃在两段之间：重试进入「ADOPTED 无 task_id」补齐路径，不会重复建任务；
 * RETURN 与已落的 ADOPT 竞争时 CAS 失败 → 409，杜绝「已退回却在跑」的孤儿任务。 */
async function adoptProposal(
  db: Db,
  proposalId: string,
  input: DecideProposalInput,
  actorId: string,
): Promise<DecisionResult> {
  const marked = await db.withTransaction(async (tx) => {
    const proposal = await getProposalForUpdate(tx, proposalId);
    if (!proposal) throw notFound(`proposal ${proposalId} not found`);
    // Batch cycle is a persisted execution boundary. Validate it before the
    // proposal state transition so a legacy unassigned batch stays retryable.
    const batch = await getBatchForUpdate(tx, proposal.batchId);
    if (!batch?.cycleId) {
      throw conflict(
        "proposal batch has no persisted cycle; create a new proposal batch instead",
        "CYCLE_MISSING",
      );
    }
    const cycleId = batch.cycleId;
    if (proposal.status === "ADOPTED") {
      // 幂等重放 / 崩溃补齐：直接进第二段。
      return { proposal, batch, cycleId };
    }
    if (proposal.status !== "PENDING") {
      throw conflict(
        `proposal is ${proposal.status}; only PENDING proposals can be adopted`,
        "PROPOSAL_NOT_PENDING",
      );
    }

    // 采纳前重做能力/绑定校验（批次创建后状态可能变化；红线：坏建议不落库）。
    const cap = requiredCapabilityFor(proposal.taskType, proposal.executionMode);
    if (cap) {
      const record = await getCapability(tx, proposal.merchantId, cap);
      if (!record || record.status !== "ACTIVE") {
        throw conflict(
          `capability ${cap} is not ACTIVE for this merchant; fix the capability matrix first`,
          "CAPABILITY_NOT_ACTIVE",
        );
      }
    }
    if (proposal.executionMode !== "MANUAL") {
      const bindingKey = dispatchBindingKey(proposal.taskType);
      const binding = await getAgentBinding(tx, bindingKey);
      if (!binding) {
        throw conflict(
          `no agent bound for ${bindingKey}; bind one in settings first`,
          "AGENT_NOT_BOUND",
        );
      }
    }
    // 依赖顺序：Planner 声明的 depends_on 必须先被采纳（退回/待定都不行）。
    for (const depSeq of proposal.dependsOn) {
      const dep = await getProposalBySeq(tx, proposal.batchId, depSeq);
      if (!dep || dep.status !== "ADOPTED") {
        throw conflict(
          `dependency #${depSeq} is ${dep?.status ?? "missing"}; adopt it first`,
          "DEPENDS_NOT_ADOPTED",
        );
      }
    }

    const now = nowIso();
    const next: Proposal = {
      ...proposal,
      status: "ADOPTED",
      decidedBy: actorId,
      decidedAt: now,
      returnReason: null,
      taskId: null,
      updatedAt: now,
    };
    // 行锁在手，CAS 必中；写成条件更新是为守住「不覆盖并发判定」的通用约定。
    await updateProposalDecisionIf(tx, next, ["PENDING"]);
    return { proposal: next, batch, cycleId };
  });

  // ---- 第二段：建任务（幂等）→ Ⓐ级只读采纳即授权 → 回填 task_id ----
  if (marked.proposal.taskId) {
    return { proposal: marked.proposal, taskId: marked.proposal.taskId };
  }

  const dependencyTaskIds: string[] = [];
  for (const depSeq of marked.proposal.dependsOn) {
    const dependency = await getProposalBySeq(db, marked.proposal.batchId, depSeq);
    if (!dependency || dependency.status !== "ADOPTED" || !dependency.taskId) {
      throw conflict(
        `dependency #${depSeq} has not finished creating its Task; retry after it is linked`,
        "DEPENDS_TASK_NOT_LINKED",
      );
    }
    dependencyTaskIds.push(dependency.taskId);
  }

  const definition: DefinitionInput = {
    title: marked.proposal.title,
    task_type: marked.proposal.taskType,
    source: marked.batch.origin === "PLAN_CONVERT" ? "PLAN" : "PROPOSAL",
    priority: input.override_priority ?? marked.proposal.priority,
    impact: marked.proposal.impact,
    execution_spec: marked.proposal.executionSpec,
    required_evidence_types: marked.proposal.requiredEvidenceTypes,
    execution_mode: marked.proposal.executionMode,
    ...(input.override_due_at ?? marked.proposal.dueAt
      ? { due_at: input.override_due_at ?? (marked.proposal.dueAt as string) }
      : {}),
  };
  const { task } = await createTask(
    db,
    {
      merchant_id: marked.proposal.merchantId,
      ...(marked.proposal.locationId ? { location_id: marked.proposal.locationId } : {}),
      definition,
      idempotency_key: `proposal:${marked.proposal.id}`,
      proposal_id: marked.proposal.id,
      cycle_id: marked.cycleId,
      depends_on_task_ids: dependencyTaskIds,
    },
    actorId,
  );

  // Ⓐ级只读建议：采纳即判定即授权 —— 直接 APPROVED 并尝试派发，不再走二次 G1。
  // （写入/成品类照旧停在双门前：内容定稿 → 门1 → 门2。）
  if (task.executionMode === "READ_ONLY") {
    await authorizeReadOnlyTask(db, task, actorId, "采纳即授权（Ⓐ级只读建议，判定人即批准人）");
    try {
      await autoDispatch(db, task.id, actorId);
    } catch {
      // 派发失败不阻塞采纳：scheduler 清扫会重试。
    }
  }

  const now = nowIso();
  await setProposalTaskId(db, marked.proposal.id, task.id, now);
  await closeBatchIfDecided(db, marked.proposal.batchId, now);
  return { proposal: { ...marked.proposal, taskId: task.id }, taskId: task.id };
}

async function returnProposal(
  db: Db,
  proposalId: string,
  input: DecideProposalInput,
  actorId: string,
): Promise<DecisionResult> {
  const result = await db.withTransaction(async (tx) => {
    const proposal = await getProposalForUpdate(tx, proposalId);
    if (!proposal) throw notFound(`proposal ${proposalId} not found`);
    if (proposal.status === "RETURNED") {
      return proposal; // 幂等重放
    }
    if (proposal.status !== "PENDING" && proposal.status !== "VALIDATION_FAILED") {
      throw conflict(
        `proposal is ${proposal.status}; only PENDING or VALIDATION_FAILED proposals can be returned`,
        "PROPOSAL_NOT_RETURNABLE",
      );
    }
    const reason = input.return_reason?.trim();
    if (!reason) throw badRequest("return_reason is required when returning a proposal");

    const now = nowIso();
    const next: Proposal = {
      ...proposal,
      status: "RETURNED",
      decidedBy: actorId,
      decidedAt: now,
      returnReason: reason,
      taskId: null,
      updatedAt: now,
    };
    await updateProposalDecisionIf(tx, next, ["PENDING", "VALIDATION_FAILED"]);
    return next;
  });
  await closeBatchIfDecided(db, result.batchId, nowIso());
  return { proposal: result, taskId: null };
}

// ---------------- 查询视图 ----------------

export async function batchView(db: Db, batchId: string): Promise<BatchWithItems> {
  const batch = await getBatch(db, batchId);
  if (!batch) throw notFound(`proposal batch ${batchId} not found`);
  return { batch, proposals: await listProposalsByBatch(db, batchId) };
}

export async function listBatchViews(db: Db, merchantId?: string): Promise<BatchWithItems[]> {
  const batches = await listBatches(db, merchantId);
  const out: BatchWithItems[] = [];
  for (const batch of batches) {
    out.push({ batch, proposals: await listProposalsByBatch(db, batch.id) });
  }
  return out;
}
