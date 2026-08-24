import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/connection.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { requestFingerprint, sha256Hash, sha256HashBytes } from "../domain/hashing.js";
import {
  AGENT_RUN_STAGES,
  CORE_RUN_TERMINAL_STATUSES,
  RUN_TYPE_BY_STAGE,
  type AgentRunStage,
  type AgentRunStatus,
} from "../domain/enums.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getLocation, listLocationsByMerchant } from "../repos/locationRepo.js";
import { latestQuestionnaireByMerchant } from "../repos/questionnaireRepo.js";
import {
  countAgentRunsByMerchantSince,
  findAgentRunByIdempotencyKey,
  getAgentRun,
  getDeliverable,
  insertAgentRun,
  listAgentRunsByMerchant,
  listDeliverablesByRun,
  transitionAgentRun,
  updateAgentRun,
  upsertDeliverable,
} from "../repos/agentRunRepo.js";
import type { AgentRun, RunDeliverable } from "../repos/agentRunTypes.js";
import { requireIdempotencyKey, resolveIdempotentCreate } from "./merchantService.js";
import {
  buildStageRunMessage,
  excerptForPrompt,
  priorStagesFor,
} from "./agentRunPrompt.js";
import { paginate, type PageResult } from "./queryService.js";
import type { CoreAgentRunDetail, CoreAiClient } from "./coreAiClient.js";

function nowIso(): string {
  return new Date().toISOString();
}

export interface AgentRunDeps {
  db: Db;
  client: CoreAiClient;
  /** core-ai agent id (UAT unified local SEO agent). */
  agentId: string;
  /** Directory where deliverable files are persisted. */
  artifactsDir: string;
  /** Per-merchant daily trigger cap — protects the core-ai token quota
   * against UI retry loops. */
  dailyRunLimit?: number;
  log?: { warn(message: string): void };
}

export interface TriggerStageRunInput {
  stage: string;
  location_id?: string | null;
  goal?: string | null;
  idempotency_key: string;
}

const DEFAULT_DAILY_RUN_LIMIT = 20;

/** 上游交付物内容可内联进 prompt 的类型（附件可能是图片等二进制）。 */
function isTextDeliverable(d: RunDeliverable): boolean {
  if (d.contentType) {
    return (
      d.contentType.startsWith("text/") ||
      d.contentType.includes("csv") ||
      d.contentType.includes("markdown") ||
      d.contentType.includes("json")
    );
  }
  return /\.(md|csv|txt|json)$/i.test(d.fileName);
}

/** 阶段串联：上游阶段最近一次 COMPLETED 运行的交付物内容（附件优先，正文兜底），
 * 截断后内联进下游 prompt。 */
export async function gatherPriorExcerpts(
  db: Db,
  merchantId: string,
  stage: AgentRunStage,
): Promise<Partial<Record<AgentRunStage, string>>> {
  const excerpts: Partial<Record<AgentRunStage, string>> = {};
  for (const priorStage of priorStagesFor(stage)) {
    const runs = await listAgentRunsByMerchant(db, merchantId, priorStage);
    const run = runs.find((r) => r.status === "COMPLETED");
    if (!run) continue;
    const deliverables = await listDeliverablesByRun(db, run.id);
    const candidate =
      deliverables.find(
        (d) => d.kind !== "SUMMARY" && d.localPath !== null && isTextDeliverable(d),
      ) ?? deliverables.find((d) => d.kind === "SUMMARY" && d.localPath !== null);
    let content: string | null = null;
    if (candidate?.localPath) {
      try {
        content = fs.readFileSync(candidate.localPath, "utf8");
      } catch {
        content = null;
      }
    }
    if (content === null) content = run.output;
    if (content && content.trim() !== "") {
      excerpts[priorStage] = excerptForPrompt(content);
    }
  }
  return excerpts;
}

function startOfUtcDayIso(): string {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

export async function triggerStageRun(
  deps: AgentRunDeps,
  merchantId: string,
  input: TriggerStageRunInput,
  actorId: string,
): Promise<{ run: AgentRun; replayed: boolean }> {
  const key = requireIdempotencyKey(input.idempotency_key, "idempotency_key");
  const stage = input.stage as AgentRunStage;
  if (!AGENT_RUN_STAGES.includes(stage)) {
    throw badRequest(`stage must be one of ${AGENT_RUN_STAGES.join("/")}`);
  }
  const rawGoal =
    input.goal === undefined || input.goal === null ? "" : input.goal.trim();
  if (rawGoal.length > 2000) {
    throw badRequest("goal must be at most 2000 characters");
  }
  const goal = rawGoal === "" ? null : rawGoal;

  const fingerprint = requestFingerprint({
    merchant_id: merchantId,
    stage,
    location_id: input.location_id ?? null,
    goal,
  });
  const replay = resolveIdempotentCreate(
    await findAgentRunByIdempotencyKey(deps.db, key),
    fingerprint,
  );
  if (replay) return { run: replay, replayed: true };

  const merchant = await getMerchant(deps.db, merchantId);
  if (!merchant) throw notFound(`merchant ${merchantId} not found`);

  let location = null;
  if (input.location_id) {
    location = await getLocation(deps.db, input.location_id);
    if (!location || location.merchantId !== merchantId) {
      throw badRequest(`location ${input.location_id} does not belong to merchant ${merchantId}`);
    }
  } else {
    // 单地点商户是常态：不传 location 就用第一个（多地点时提示显式选择）。
    const locations = await listLocationsByMerchant(deps.db, merchantId);
    location = locations[0] ?? null;
  }

  const limit = deps.dailyRunLimit ?? DEFAULT_DAILY_RUN_LIMIT;
  if ((await countAgentRunsByMerchantSince(deps.db, merchantId, startOfUtcDayIso())) >= limit) {
    throw new ApiError(
      429,
      `merchant ${merchantId} reached the daily run limit (${limit})`,
      "RUN_LIMIT_REACHED",
    );
  }

  const questionnaire = await latestQuestionnaireByMerchant(deps.db, merchantId);
  const message = buildStageRunMessage({
    stage,
    merchant,
    location,
    questionnaire,
    priorExcerpts: await gatherPriorExcerpts(deps.db, merchantId, stage),
    goal,
  });

  const now = nowIso();
  const run: AgentRun = {
    id: crypto.randomUUID(),
    merchantId,
    locationId: location?.id ?? null,
    stage,
    taskId: null,
    runType: RUN_TYPE_BY_STAGE[stage],
    goal,
    status: "TRIGGERING",
    coreRunId: null,
    coreStatus: null,
    inputMessage: message,
    output: null,
    error: null,
    errorCode: null,
    tokenUsage: {},
    triggeredBy: actorId,
    triggeredAt: now,
    lastPolledAt: null,
    completedAt: null,
    creationIdempotencyKey: key,
    requestFingerprint: fingerprint,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  };

  // Row lands first so the 202/response always has a durable record.
  const inserted = await deps.db.withTransaction(async (tx) => {
    const raced = resolveIdempotentCreate(
      await findAgentRunByIdempotencyKey(tx, key),
      fingerprint,
    );
    if (raced) return raced;
    await insertAgentRun(tx, run);
    return run;
  });
  if (inserted !== run) return { run: inserted, replayed: true };

  // Network I/O must stay OUTSIDE db.withTransaction (a dedicated pool client
  // is held for the transaction's duration; awaiting the HTTP call inside it
  // would starve the pool for as long as core-ai takes to answer).
  try {
    const triggered = await deps.client.trigger(deps.agentId, run.inputMessage);
    run.coreRunId = triggered.run_id;
    run.coreStatus = triggered.status;
    run.status = "RUNNING";
    run.updatedAt = nowIso();
    await updateAgentRun(deps.db, run);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "network error";
    run.status = "FAILED";
    run.error = detail;
    run.errorCode = "TRIGGER_FAILED";
    run.completedAt = nowIso();
    run.updatedAt = run.completedAt;
    await updateAgentRun(deps.db, run);
    throw new ApiError(502, `core-ai trigger failed: ${detail}`, "CORE_AI_TRIGGER_FAILED");
  }
  return { run, replayed: false };
}

/** Atomic file write: tmp + rename, idempotent on identical bytes. */
function writeFileAtomic(filePath: string, bytes: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  if (typeof bytes === "string") fs.writeFileSync(tmpPath, bytes, "utf8");
  else fs.writeFileSync(tmpPath, bytes);
  fs.renameSync(tmpPath, filePath);
}

/** Filesystem-safe deliverable file name: <runId>-<tag>-<fileName>. */
function deliverableFileName(runId: string, tag: string, fileName: string): string {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "file";
  return `${runId}-${tag}-${safe}`;
}

/** 终态第一步：正文落盘 + 附件下载，全部落成 deliverable 行。每个 id 由
 * (run, 来源) 决定性生成，upsert 让崩溃重放天然幂等；单个附件下载失败只记
 * download_error、保留 remote_url，绝不失败整个运行。 */
export async function recordDeliverables(
  deps: AgentRunDeps,
  run: AgentRun,
  core: CoreAgentRunDetail,
): Promise<RunDeliverable[]> {
  const saved: RunDeliverable[] = [];
  const stamp = core.completed_at ?? nowIso();

  const output = core.output ?? null;
  if (core.status === "COMPLETED" && output !== null && output.trim() !== "") {
    const filePath = path.join(deps.artifactsDir, `${run.id}.md`);
    writeFileAtomic(filePath, output);
    saved.push(
      await upsertDeliverable(deps.db, {
        id: `${run.id}-summary`,
        runId: run.id,
        kind: "SUMMARY",
        fileId: null,
        fileName: `${run.id}.md`,
        contentType: "text/markdown",
        size: Buffer.byteLength(output, "utf8"),
        title: null,
        description: null,
        sha256: sha256Hash(output),
        localPath: filePath,
        remoteUrl: null,
        downloadedAt: stamp,
        downloadError: null,
        createdAt: stamp,
      }),
    );
  }

  for (const [index, artifact] of (core.artifacts ?? []).entries()) {
    let localPath: string | null = null;
    let sha: string | null = null;
    let size: number | null = artifact.size ?? null;
    let downloadError: string | null = null;
    try {
      const bytes = await deps.client.downloadArtifact(artifact.download_url);
      const filePath = path.join(
        deps.artifactsDir,
        deliverableFileName(run.id, String(index), artifact.file_name),
      );
      writeFileAtomic(filePath, bytes);
      localPath = filePath;
      sha = sha256HashBytes(bytes);
      size = bytes.byteLength;
    } catch (err) {
      downloadError = err instanceof Error ? err.message : "download failed";
      deps.log?.warn(
        `run ${run.id}: attachment ${artifact.file_name} download failed, keeping remote ref: ${downloadError}`,
      );
    }
    saved.push(
      await upsertDeliverable(deps.db, {
        id: `${run.id}-att-${artifact.file_id}`,
        runId: run.id,
        kind: "ATTACHMENT",
        fileId: artifact.file_id,
        fileName: artifact.file_name,
        contentType: artifact.content_type ?? null,
        size,
        title: artifact.title ?? null,
        description: artifact.description ?? null,
        sha256: sha,
        localPath,
        remoteUrl: artifact.download_url,
        downloadedAt: localPath ? nowIso() : null,
        downloadError,
        createdAt: stamp,
      }),
    );
  }
  return saved;
}

function isCoreTerminal(status: string): boolean {
  return (CORE_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

function mapCoreStatus(coreStatus: string): AgentRunStatus {
  if (coreStatus === "COMPLETED") return "COMPLETED";
  if (coreStatus === "CANCELLED") return "CANCELLED";
  return "FAILED"; // FAILED / TIMEOUT / SKIPPED
}

/** 终态第二步：条件翻转 run 行（单写者守卫）。调用顺序是崩溃安全的关键——
 * recordDeliverables 先行；这里失败或崩溃时行仍 RUNNING，下轮 poll 整体重放。 */
export async function applyTerminalTransition(
  deps: AgentRunDeps,
  run: AgentRun,
  core: CoreAgentRunDetail,
): Promise<AgentRun> {
  if (!isCoreTerminal(core.status)) return run;
  if (run.status !== "RUNNING" && run.status !== "TRIGGERING") return run;

  const transitioned = await transitionAgentRun(
    deps.db,
    run.id,
    {
      status: mapCoreStatus(core.status),
      coreStatus: core.status,
      output: core.output ?? null,
      error: core.error ?? null,
      tokenUsage: core.token_usage ?? {},
      completedAt: core.completed_at ?? nowIso(),
      lastPolledAt: nowIso(),
    },
    ["RUNNING", "TRIGGERING"],
  );
  const final = transitioned ?? (await getAgentRun(deps.db, run.id));
  return final ?? run;
}

export function syntheticCancelledRun(run: AgentRun): CoreAgentRunDetail {
  return {
    id: run.coreRunId ?? "",
    agent_id: "",
    status: "CANCELLED",
    output: null,
    error: "cancelled by operator",
    completed_at: nowIso(),
  };
}

export async function cancelStageRun(
  deps: AgentRunDeps,
  id: string,
): Promise<AgentRun> {
  const run = await getAgentRun(deps.db, id);
  if (!run) throw notFound(`agent run ${id} not found`);
  if (run.status !== "TRIGGERING" && run.status !== "RUNNING") {
    throw conflict(
      `agent run ${id} is not active (status ${run.status})`,
      "RUN_NOT_ACTIVE",
    );
  }

  // No core-ai run id yet — nothing remote to cancel; cancel locally.
  if (run.coreRunId === null) {
    return applyTerminalTransition(deps, run, syntheticCancelledRun(run));
  }

  try {
    await deps.client.cancel(run.coreRunId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "network error";
    throw new ApiError(502, `core-ai cancel failed: ${detail}`, "CORE_AI_CANCEL_FAILED");
  }

  let core: CoreAgentRunDetail;
  try {
    core = await deps.client.getRun(run.coreRunId);
  } catch {
    core = syntheticCancelledRun(run);
  }
  if (!isCoreTerminal(core.status)) {
    // core-ai cancel flips RUNNING -> CANCELLED directly; if the refresh lags,
    // treat it as cancelled rather than leaving the row dangling.
    core = syntheticCancelledRun(run);
  }
  await recordDeliverables(deps, run, core);
  return applyTerminalTransition(deps, run, core);
}

export interface ManualDeliverableInput {
  file_name: string;
  content_type?: string | null;
  /** Base64-encoded bytes (JSON transport keeps the route dependency-free). */
  content_base64: string;
}

/** 兜底：agent 只回正文不回附件时，运营手工上传交付物解锁阶段。 */
export async function addManualDeliverable(
  deps: Pick<AgentRunDeps, "db" | "artifactsDir">,
  runId: string,
  input: ManualDeliverableInput,
): Promise<RunDeliverable> {
  const run = await getAgentRun(deps.db, runId);
  if (!run) throw notFound(`agent run ${runId} not found`);
  if (run.status !== "COMPLETED") {
    throw conflict(
      `agent run ${runId} is not COMPLETED (status ${run.status})`,
      "RUN_NOT_COMPLETED",
    );
  }
  const fileName = input.file_name.trim();
  if (fileName === "") throw badRequest("file_name must not be empty");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(input.content_base64, "base64");
  } catch {
    throw badRequest("content_base64 must be valid base64");
  }
  if (bytes.byteLength === 0) throw badRequest("content must not be empty");
  if (bytes.byteLength > 10 * 1024 * 1024) {
    throw badRequest("manual deliverable must be at most 10MB");
  }

  const id = crypto.randomUUID();
  const filePath = path.join(
    deps.artifactsDir,
    deliverableFileName(runId, `manual-${id.slice(0, 8)}`, fileName),
  );
  writeFileAtomic(filePath, bytes);
  const now = nowIso();
  return upsertDeliverable(deps.db, {
    id,
    runId,
    kind: "MANUAL",
    fileId: null,
    fileName,
    contentType: input.content_type ?? null,
    size: bytes.byteLength,
    title: null,
    description: null,
    sha256: sha256HashBytes(bytes),
    localPath: filePath,
    remoteUrl: null,
    downloadedAt: now,
    downloadError: null,
    createdAt: now,
  });
}

export async function listStageRuns(
  db: Db,
  merchantId: string,
  params: { stage?: string; offset: number; limit: number },
): Promise<PageResult<AgentRun>> {
  if (!(await getMerchant(db, merchantId))) {
    throw notFound(`merchant ${merchantId} not found`);
  }
  return paginate(
    await listAgentRunsByMerchant(db, merchantId, params.stage),
    params.offset,
    params.limit,
  );
}

export async function getAgentRunOr404(db: Db, id: string): Promise<AgentRun> {
  const run = await getAgentRun(db, id);
  if (!run) throw notFound(`agent run ${id} not found`);
  return run;
}

export async function getDeliverableOr404(db: Db, id: string): Promise<RunDeliverable> {
  const deliverable = await getDeliverable(db, id);
  if (!deliverable) throw notFound(`deliverable ${id} not found`);
  return deliverable;
}

export interface DeliverableWire {
  id: string;
  kind: string;
  file_name: string;
  content_type: string | null;
  size: number | null;
  title: string | null;
  description: string | null;
  sha256: string | null;
  downloaded: boolean;
  download_error?: string;
  /** Local serving route — the durable evidence copy. */
  download_path: string;
  /** 本地 demo 便利:core-ai 原始附件直链(浏览器可达且有权限时可用);
   * 证据主通道仍是 download_path,该字段仅供「在 core-ai 打开」跳转。 */
  core_url: string | null;
  created_at: string;
}

export function deliverableView(d: RunDeliverable): DeliverableWire {
  return {
    id: d.id,
    kind: d.kind,
    file_name: d.fileName,
    content_type: d.contentType,
    size: d.size,
    title: d.title,
    description: d.description,
    sha256: d.sha256,
    downloaded: d.localPath !== null,
    ...(d.downloadError ? { download_error: d.downloadError } : {}),
    download_path: `/api/seo-ops/deliverables/${d.id}/download`,
    core_url: d.remoteUrl,
    created_at: d.createdAt,
  };
}

export interface StageRunWire {
  id: string;
  merchant_id: string;
  location_id: string | null;
  stage: AgentRunStage;
  run_type: string;
  goal: string | null;
  status: AgentRunStatus;
  core_run_id?: string;
  core_status?: string;
  input_message: string;
  output?: string | null;
  output_preview?: string | null;
  error?: string;
  error_code?: string;
  token_usage: Record<string, number>;
  deliverables: DeliverableWire[];
  triggered_by: string;
  triggered_at: string;
  last_polled_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

/** snake_case wire view; lists get a 2000-char output preview, detail gets
 * the full output. Deliverables always ride along — they are the product. */
export function stageRunView(
  run: AgentRun,
  deliverables: RunDeliverable[],
  opts: { includeFullOutput?: boolean } = {},
): StageRunWire {
  const preview =
    run.output === null
      ? null
      : run.output.length > 2000
        ? run.output.slice(0, 2000)
        : run.output;
  return {
    id: run.id,
    merchant_id: run.merchantId,
    location_id: run.locationId,
    stage: run.stage,
    run_type: run.runType,
    goal: run.goal,
    status: run.status,
    ...(run.coreRunId ? { core_run_id: run.coreRunId } : {}),
    ...(run.coreStatus ? { core_status: run.coreStatus } : {}),
    input_message: run.inputMessage,
    ...(opts.includeFullOutput
      ? { output: run.output }
      : { output_preview: preview }),
    ...(run.error ? { error: run.error } : {}),
    ...(run.errorCode ? { error_code: run.errorCode } : {}),
    token_usage: run.tokenUsage,
    deliverables: deliverables.map(deliverableView),
    triggered_by: run.triggeredBy,
    triggered_at: run.triggeredAt,
    ...(run.lastPolledAt ? { last_polled_at: run.lastPolledAt } : {}),
    ...(run.completedAt ? { completed_at: run.completedAt } : {}),
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}
