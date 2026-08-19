import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db/connection.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import { requestFingerprint, sha256Hash } from "../domain/hashing.js";
import { canAppendEvidence } from "../domain/stateMachine.js";
import {
  AGENT_RUN_TYPES,
  CORE_RUN_TERMINAL_STATUSES,
  EVIDENCE_TYPE_BY_RUN_TYPE,
  type AgentRunStatus,
  type AgentRunType,
} from "../domain/enums.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getLocation } from "../repos/locationRepo.js";
import { getTask } from "../repos/taskRepo.js";
import {
  findAgentRunByIdempotencyKey,
  getAgentRun,
  insertAgentRun,
  listAgentRunsByTask,
  transitionAgentRun,
  updateAgentRun,
} from "../repos/agentRunRepo.js";
import type { AgentRun } from "../repos/agentRunTypes.js";
import type { EvidenceRefRecord, Task } from "../repos/taskTypes.js";
import { requireIdempotencyKey, resolveIdempotentCreate } from "./merchantService.js";
import { buildAgentRunMessage } from "./agentRunPrompt.js";
import {
  ACTOR_ID,
  buildEvent,
  mutateTaskRetry,
  reevaluate,
} from "./taskService.js";
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
  /** Directory where run outputs are persisted as artifacts. */
  artifactsDir: string;
  log?: { warn(message: string): void };
}

export interface TriggerAgentRunInput {
  run_type: string;
  goal?: string | null;
  idempotency_key: string;
}

/** Sync the task-side link (and append the TRIGGERED event) for a run. */
function taskWithTriggeredLink(task: Task, run: AgentRun): Task {
  const now = nowIso();
  const linked = task.agentRunLinks.some((l) => l.agentRunId === run.id);
  const updated: Task = {
    ...task,
    agentRunLinks: linked
      ? task.agentRunLinks.map((l) =>
          l.agentRunId === run.id ? { ...l, status: "RUNNING" } : l,
        )
      : [
          ...task.agentRunLinks,
          {
            agentRunId: run.id,
            relationship: run.runType,
            status: "RUNNING",
            linkedBy: ACTOR_ID,
            linkedAt: now,
          },
        ],
    stateVersion: task.stateVersion + 1,
    updatedAt: now,
  };
  updated.events = [
    ...task.events,
    buildEvent("AGENT_RUN_TRIGGERED", updated.taskRevision, updated.stateVersion, {
      referenceId: run.id,
    }),
  ];
  return updated;
}

export async function triggerAgentRun(
  deps: AgentRunDeps,
  taskId: string,
  input: TriggerAgentRunInput,
): Promise<{ run: AgentRun; replayed: boolean }> {
  const key = requireIdempotencyKey(input.idempotency_key, "idempotency_key");
  const runType = input.run_type as AgentRunType;
  if (!AGENT_RUN_TYPES.includes(runType)) {
    throw badRequest(`run_type must be one of ${AGENT_RUN_TYPES.join("/")}`);
  }
  const rawGoal =
    input.goal === undefined || input.goal === null ? "" : input.goal.trim();
  if (rawGoal.length > 2000) {
    throw badRequest("goal must be at most 2000 characters");
  }
  const goal = rawGoal === "" ? null : rawGoal;

  const fingerprint = requestFingerprint({
    task_id: taskId,
    run_type: runType,
    goal,
  });

  const replay = resolveIdempotentCreate(
    findAgentRunByIdempotencyKey(deps.db, key),
    fingerprint,
  );
  if (replay) return { run: replay, replayed: true };

  const task = getTask(deps.db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  const merchant = getMerchant(deps.db, task.merchantId);
  const location = task.locationId ? getLocation(deps.db, task.locationId) : null;
  const message = buildAgentRunMessage({ runType, task, merchant, location, goal });

  const now = nowIso();
  const run: AgentRun = {
    id: crypto.randomUUID(),
    taskId,
    runType,
    goal,
    status: "TRIGGERING",
    coreRunId: null,
    coreStatus: null,
    inputMessage: message,
    output: null,
    error: null,
    errorCode: null,
    tokenUsage: {},
    artifactPath: null,
    artifactSha256: null,
    evidenceId: null,
    evidenceSkippedReason: null,
    triggeredBy: ACTOR_ID,
    triggeredAt: now,
    lastPolledAt: null,
    completedAt: null,
    creationIdempotencyKey: key,
    requestFingerprint: fingerprint,
    createdBy: ACTOR_ID,
    createdAt: now,
    updatedAt: now,
  };

  // Row lands first so the 202/response always has a durable record.
  const inserted = deps.db.transaction(() => {
    const raced = resolveIdempotentCreate(
      findAgentRunByIdempotencyKey(deps.db, key),
      fingerprint,
    );
    if (raced) return raced;
    insertAgentRun(deps.db, run);
    return run;
  })();
  if (inserted !== run) return { run: inserted, replayed: true };

  // Network I/O must stay OUTSIDE db.transaction (better-sqlite3 is sync).
  try {
    const triggered = await deps.client.trigger(deps.agentId, run.inputMessage);
    run.coreRunId = triggered.run_id;
    run.coreStatus = triggered.status;
    run.status = "RUNNING";
    run.updatedAt = nowIso();
    updateAgentRun(deps.db, run);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "network error";
    run.status = "FAILED";
    run.error = detail;
    run.errorCode = "TRIGGER_FAILED";
    run.completedAt = nowIso();
    run.updatedAt = run.completedAt;
    updateAgentRun(deps.db, run);
    throw new ApiError(502, `core-ai trigger failed: ${detail}`, "CORE_AI_TRIGGER_FAILED");
  }

  // Best-effort link onto the task; a failure here must not fail the 202 —
  // applyTerminalTransition re-creates the link if it is still missing.
  try {
    mutateTaskRetry(
      deps.db,
      taskId,
      `agent-run:${run.id}:link`,
      fingerprint,
      (t) => taskWithTriggeredLink(t, run),
    );
  } catch (err) {
    deps.log?.warn(
      `agent run ${run.id}: failed to link onto task ${taskId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { run, replayed: false };
}

/** Atomic artifact write: tmp file + rename, idempotent on identical bytes. */
function writeArtifact(artifactsDir: string, runId: string, content: string): string {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const finalPath = path.join(artifactsDir, `${runId}.md`);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

function isCoreTerminal(status: string): boolean {
  return (CORE_RUN_TERMINAL_STATUSES as readonly string[]).includes(status);
}

function mapCoreStatus(coreStatus: string): AgentRunStatus {
  if (coreStatus === "COMPLETED") return "COMPLETED";
  if (coreStatus === "CANCELLED") return "CANCELLED";
  return "FAILED"; // FAILED / TIMEOUT / SKIPPED
}

/** Record a terminal core-ai outcome for a RUNNING local run.
 *
 * Crash-safe ordering — each step is independently idempotent:
 *   (a) artifact write (same bytes) -> (b) task mutation (replays via
 *   mutationKeys) -> (c) run-row conditional transition LAST, so a crash
 *   before (c) leaves the row RUNNING and the next poll replays (a)+(b). */
export function applyTerminalTransition(
  deps: AgentRunDeps,
  run: AgentRun,
  core: CoreAgentRunDetail,
): AgentRun {
  if (!isCoreTerminal(core.status)) return run;
  if (run.status !== "RUNNING") return run;

  const mapped = mapCoreStatus(core.status);
  const output = core.output ?? null;
  const changes: Partial<AgentRun> = {
    status: mapped,
    coreStatus: core.status,
    output,
    error: core.error ?? null,
    tokenUsage: core.token_usage ?? {},
    completedAt: core.completed_at ?? nowIso(),
    lastPolledAt: nowIso(),
  };

  // (a) artifact — only for a completed run with non-empty output.
  let sha: string | null = null;
  if (mapped === "COMPLETED" && output !== null && output.trim() !== "") {
    sha = sha256Hash(output);
    changes.artifactPath = writeArtifact(deps.artifactsDir, run.id, output);
    changes.artifactSha256 = sha;
  }

  // (b) task mutation — evidence append + link sync + event. The fingerprint
  // excludes the output so a replay after a crash matches deterministically.
  try {
    const result = mutateTaskRetry(
      deps.db,
      run.taskId,
      `agent-run:${run.id}:complete`,
      requestFingerprint({ core_run_id: core.id, core_status: core.status }),
      (task) => {
        const now = nowIso();
        let evidenceRefs = task.evidenceRefs;
        if (mapped === "COMPLETED" && sha !== null && canAppendEvidence(task.status)) {
          const type = EVIDENCE_TYPE_BY_RUN_TYPE[run.runType];
          const evidence: EvidenceRefRecord = {
            id: crypto.randomUUID(),
            taskRevision: task.taskRevision,
            type,
            artifactId: run.id,
            sha256: sha,
            capturedAt: core.completed_at ?? now,
            verificationStatus: "UNVERIFIED",
            requirementKey: type,
            createdBy: ACTOR_ID,
            createdAt: now,
          };
          evidenceRefs = [...task.evidenceRefs, evidence];
        }
        const linked = task.agentRunLinks.some((l) => l.agentRunId === run.id);
        const updated: Task = {
          ...task,
          evidenceRefs,
          agentRunLinks: linked
            ? task.agentRunLinks.map((l) =>
                l.agentRunId === run.id ? { ...l, status: core.status } : l,
              )
            : [
                ...task.agentRunLinks,
                {
                  agentRunId: run.id,
                  relationship: run.runType,
                  status: core.status,
                  linkedBy: ACTOR_ID,
                  linkedAt: now,
                },
              ],
          stateVersion: task.stateVersion + 1,
          updatedAt: now,
        };
        const derived = reevaluate(deps.db, updated);
        updated.status = derived.status;
        updated.evidenceState = derived.evidenceState;
        const eventType =
          mapped === "COMPLETED" ? "AGENT_RUN_COMPLETED"
          : mapped === "CANCELLED" ? "AGENT_RUN_CANCELLED"
          : "AGENT_RUN_FAILED";
        updated.events = [
          ...task.events,
          buildEvent(eventType, updated.taskRevision, updated.stateVersion, {
            fromStatus: task.status,
            toStatus: derived.status,
            referenceId: run.id,
          }),
        ];
        return updated;
      },
    );
    const appended =
      result.task.evidenceRefs.find((e) => e.artifactId === run.id) ?? null;
    changes.evidenceId = appended ? appended.id : null;
    changes.evidenceSkippedReason =
      appended === null && mapped === "COMPLETED"
        ? sha !== null
          ? "task status does not accept evidence (append skipped)"
          : "agent produced no output"
        : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      changes.evidenceSkippedReason = "task no longer exists";
      deps.log?.warn(
        `agent run ${run.id}: task ${run.taskId} disappeared before completion`,
      );
    } else {
      throw err;
    }
  }

  // (c) conditional transition LAST — single-winner guard.
  const final =
    transitionAgentRun(deps.db, run.id, changes, ["RUNNING"]) ??
    getAgentRun(deps.db, run.id);
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

export async function cancelAgentRun(
  deps: AgentRunDeps,
  id: string,
): Promise<AgentRun> {
  const run = getAgentRun(deps.db, id);
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
  return applyTerminalTransition(deps, run, core);
}

export function listAgentRuns(
  db: Db,
  taskId: string,
  params: { offset: number; limit: number },
): PageResult<AgentRun> {
  if (!getTask(db, taskId)) throw notFound(`task ${taskId} not found`);
  return paginate(listAgentRunsByTask(db, taskId), params.offset, params.limit);
}

export function getAgentRunOr404(db: Db, id: string): AgentRun {
  const run = getAgentRun(db, id);
  if (!run) throw notFound(`agent run ${id} not found`);
  return run;
}

export interface AgentRunWire {
  id: string;
  task_id: string;
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
  artifact_path?: string;
  artifact_sha256?: string;
  evidence_id?: string;
  evidence_skipped_reason?: string;
  triggered_by: string;
  triggered_at: string;
  last_polled_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

/** snake_case wire view; lists get a 2000-char output preview, detail gets
 * the full output. */
export function agentRunView(
  run: AgentRun,
  opts: { includeFullOutput?: boolean } = {},
): AgentRunWire {
  const preview =
    run.output === null
      ? null
      : run.output.length > 2000
        ? run.output.slice(0, 2000)
        : run.output;
  return {
    id: run.id,
    task_id: run.taskId,
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
    ...(run.artifactPath ? { artifact_path: run.artifactPath } : {}),
    ...(run.artifactSha256 ? { artifact_sha256: run.artifactSha256 } : {}),
    ...(run.evidenceId ? { evidence_id: run.evidenceId } : {}),
    ...(run.evidenceSkippedReason
      ? { evidence_skipped_reason: run.evidenceSkippedReason }
      : {}),
    triggered_by: run.triggeredBy,
    triggered_at: run.triggeredAt,
    ...(run.lastPolledAt ? { last_polled_at: run.lastPolledAt } : {}),
    ...(run.completedAt ? { completed_at: run.completedAt } : {}),
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}
