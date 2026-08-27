import crypto from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import type { Db } from "../db/connection.js";
import {
  GbpExecutionReceiptSchema,
  canonicalGbpCommand,
  type GbpSafeErrorCode,
} from "../domain/gbpExecutionContract.js";
import { canonicalize, executionSpecHash, sha256HashBytes } from "../domain/hashing.js";
import { getAgentRun, getDeliverable } from "../repos/agentRunRepo.js";
import { getDraftByTaskVersion } from "../repos/draftRepo.js";
import {
  claimNextGbpCommand,
  getGbpLocationBinding,
  insertGbpReceipt,
  markGbpCommandBlockedPreSend,
  markGbpCommandOutcomeUnknown,
  markGbpCommandReadbackPending,
  markGbpCommandReceiptAccepted,
  markGbpCommandRunning,
  markGbpCommandTriggering,
} from "../repos/gbpExecutionRepo.js";
import type { GbpCommandClaim, GbpCommandState } from "../repos/types.js";
import { getTask } from "../repos/taskRepo.js";
import { draftSha256 } from "./contentService.js";
import { createGbpCoreAiClient, type GbpCoreAiClient } from "./gbpCoreAiClient.js";
import { resolveGbpCredential } from "./gbpCredentialResolver.js";

const UuidSchema = z.string().uuid();
const MediaRefSchema = z.object({
  schema_version: z.literal("seo_ops.media_ref.v1"),
  deliverable_id: UuidSchema,
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  alt_text: z.string().min(1).max(500),
}).strict();
const DraftSnapshotSchema = z.object({
  draft_version: z.number().int().positive(),
  draft_sha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/),
  body: z.string().min(1).max(1_500),
  cta_type: z.enum(["NONE", "BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]).nullable(),
  cta_url: z.string().nullable(),
  media: z.array(z.string()).length(1),
}).strict();

const RUNNING_STATUSES = new Set(["QUEUED", "PENDING", "RUNNING", "TRIGGERING"]);
const DEFAULT_LEASE_MS = 10 * 60_000;

export interface GbpExecutionWorkerDeps {
  db: Db;
  coreAiBaseUrl: string;
  secretDir: string;
  createClient?: (options: { baseUrl: string; token: string; timeoutMs: number }) => GbpCoreAiClient;
  coreHttpTimeoutMs?: number;
  leaseMs?: number;
  pollIntervalMs?: number;
  maxPolls?: number;
  intervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
}

export type GbpExecutionWorkerResult =
  | { status: "IDLE" }
  | { status: "BLOCKED_PRE_SEND" | "OUTCOME_UNKNOWN" | "READBACK_PENDING" | "CLAIM_LOST"; commandId: string };

interface CandidateScope { merchant_id: string; location_id: string }

function nowIso(now: Date): string {
  if (Number.isNaN(now.getTime())) throw new Error("invalid worker time");
  return now.toISOString();
}

function sameBinding(claim: GbpCommandClaim, current: NonNullable<Awaited<ReturnType<typeof getGbpLocationBinding>>>): boolean {
  const command = claim.command.command;
  return current.id === claim.command.bindingId
    && current.stateVersion === claim.command.bindingStateVersion
    && current.status === "READY"
    && current.accountResource === command.gbp.account_resource
    && current.locationResource === command.gbp.location_resource
    && current.timezone === command.gbp.timezone
    && current.coreApiUserId === command.core.api_user_id
    && current.coreApiUserExternalId === command.core.api_user_external_id
    && current.writeSecretRef === command.core.write_secret_ref
    && current.readbackSecretRef === command.core.readback_secret_ref
    && current.writeAgentId === command.core.write_agent_id
    && current.writeAgentPublishedRef === command.core.write_agent_published_ref
    && current.readbackAgentId === command.core.readback_agent_id
    && current.readbackAgentPublishedRef === command.core.readback_agent_published_ref;
}

async function validateTaskDraftAndMedia(db: Db, claim: GbpCommandClaim): Promise<boolean> {
  const command = claim.command.command;
  const task = await getTask(db, command.task.id);
  if (!task || task.id !== command.task.id || task.merchantId !== command.task.merchant_id
    || task.locationId !== command.task.location_id || task.taskType !== "GBP_POST"
    || task.executionMode !== "AUTO_WRITE" || task.status !== "EXECUTION_CONFIRMED"
    || task.taskRevision !== command.task.task_revision
    || task.executionSpecHash !== command.task.execution_spec_sha256
    || executionSpecHash(task.executionSpec) !== command.task.execution_spec_sha256
    || !task.approvalDecisions.some((decision) => decision.id === command.task.approval_decision_id
      && decision.decision === "APPROVE" && decision.taskRevision === command.task.task_revision
      && decision.executionSpecHash === command.task.execution_spec_sha256)) return false;

  let rawSpec: unknown;
  try { rawSpec = JSON.parse(task.executionSpec); } catch { return false; }
  const rawDraft = rawSpec && typeof rawSpec === "object" && !Array.isArray(rawSpec)
    ? (rawSpec as Record<string, unknown>).content_draft : null;
  const snapshot = DraftSnapshotSchema.safeParse(rawDraft);
  if (!snapshot.success) return false;
  const media = (() => {
    try { return MediaRefSchema.safeParse(JSON.parse(snapshot.data.media[0]!)); } catch { return null; }
  })();
  if (!media || !media.success) return false;
  const draft = await getDraftByTaskVersion(db, task.id, snapshot.data.draft_version);
  const storedDigest = draft?.sha256.replace(/^sha256:/, "") ?? "";
  const snapshotDigest = snapshot.data.draft_sha256.replace(/^sha256:/, "");
  if (!draft || draft.id !== command.draft.id || draft.taskId !== task.id
    || draft.version !== command.draft.version || storedDigest !== snapshotDigest
    || `sha256:${storedDigest}` !== command.draft.sha256
    || draftSha256({ body: draft.body, ctaType: draft.ctaType, ctaUrl: draft.ctaUrl, media: draft.media }) !== storedDigest
    || draft.body !== snapshot.data.body || draft.body !== command.draft.body
    || draft.ctaType !== snapshot.data.cta_type || (draft.ctaType ?? "NONE") !== command.draft.cta.type
    || draft.ctaUrl !== snapshot.data.cta_url || draft.ctaUrl !== command.draft.cta.url
    || canonicalize(JSON.stringify(draft.media)) !== canonicalize(JSON.stringify(snapshot.data.media))
    || media.data.deliverable_id !== command.draft.image.deliverable_id
    || media.data.sha256 !== command.draft.image.sha256
    || media.data.alt_text !== command.draft.image.alt_text) return false;

  const deliverable = await getDeliverable(db, media.data.deliverable_id);
  const sourceRunId = draft.agentRunId ?? draft.mediaSourceAgentRunId;
  const sourceRun = sourceRunId ? await getAgentRun(db, sourceRunId) : null;
  if (!deliverable || !sourceRun || deliverable.runId !== sourceRunId
    || sourceRun.taskId !== task.id || sourceRun.merchantId !== task.merchantId
    || sourceRun.locationId !== task.locationId || sourceRun.stage !== "GBP_POST_CONTENT"
    || deliverable.kind !== "ATTACHMENT"
    || !["image/png", "image/jpeg"].includes(deliverable.contentType ?? "")
    || deliverable.sha256 !== command.draft.image.sha256
    || deliverable.localPath === null || deliverable.size === null) return false;
  try {
    const bytes = await fs.readFile(deliverable.localPath);
    return bytes.byteLength === deliverable.size && sha256HashBytes(bytes) === command.draft.image.sha256;
  } catch {
    return false;
  }
}

function buildWriteInput(claim: GbpCommandClaim): string {
  return canonicalize(JSON.stringify({
    schema_version: "seo_ops.gbp_write_request.v1",
    command_sha256: claim.command.commandSha256,
    command: JSON.parse(canonicalGbpCommand(claim.command.command)),
  }));
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export class GbpExecutionWorker {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly backgroundWorkerId = `gbp-worker-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;

  constructor(private readonly deps: GbpExecutionWorkerDeps) {}

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.deps.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.runOneGbpExecution(this.backgroundWorkerId, new Date());
    } catch {
      this.deps.log?.("GBP execution worker failed safely");
    } finally {
      this.polling = false;
    }
  }

  async runOneGbpExecution(workerId: string, now: Date = new Date()): Promise<GbpExecutionWorkerResult> {
    const timestamp = nowIso(now);
    const maxPolls = Math.max(1, this.deps.maxPolls ?? 120);
    const coreHttpTimeoutMs = Math.max(1, this.deps.coreHttpTimeoutMs ?? 15_000);
    const corePollIntervalMs = Math.max(0, this.deps.pollIntervalMs ?? 3_000);

    // A process can die after persisting the monotonic trigger marker but
    // before it can classify the trigger/Run. Once its lease is definitely
    // expired, freeze that ambiguity; this branch can never call Core.
    const staleMarker = await this.deps.db.one<{ command_id: string }>(
      `WITH candidate AS (
         SELECT s.command_id
           FROM seo_gbp_command_states s JOIN seo_gbp_commands c ON c.id=s.command_id
          WHERE s.merchant_id=c.merchant_id AND s.location_id=c.location_id
            AND s.status IN ('TRIGGERING','RUNNING')
            AND s.trigger_started_at IS NOT NULL AND s.resolved_at IS NULL
            AND s.lease_expires_at <= $1::timestamptz
          ORDER BY s.updated_at, s.command_id
          FOR UPDATE OF s SKIP LOCKED LIMIT 1
       )
       UPDATE seo_gbp_command_states s SET
         status='OUTCOME_UNKNOWN', state_version=s.state_version+1,
         safe_error_code='TRIGGER_AMBIGUOUS', updated_at=$1::timestamptz
        FROM candidate
       WHERE s.command_id=candidate.command_id
       RETURNING s.command_id`,
      [timestamp],
    );
    if (staleMarker) return { status: "OUTCOME_UNKNOWN", commandId: staleMarker.command_id };

    const scope = await this.deps.db.one<CandidateScope>(
      `SELECT c.merchant_id, c.location_id
         FROM seo_gbp_command_states s JOIN seo_gbp_commands c ON c.id=s.command_id
        WHERE s.merchant_id=c.merchant_id AND s.location_id=c.location_id
          AND s.resolved_at IS NULL AND s.trigger_started_at IS NULL
          AND s.scheduled_for <= $1::timestamptz
          AND (s.status='SCHEDULED'
               OR (s.status='CLAIMED' AND s.lease_expires_at <= $1::timestamptz))
        ORDER BY s.scheduled_for, s.command_id LIMIT 1`,
      [timestamp],
    );
    if (!scope) return { status: "IDLE" };
    const minimumLeaseMs = maxPolls * (coreHttpTimeoutMs + corePollIntervalMs) + 60_000;
    const leaseMs = Math.max(this.deps.leaseMs ?? DEFAULT_LEASE_MS, minimumLeaseMs);
    const claim = await claimNextGbpCommand(this.deps.db, {
      merchantId: scope.merchant_id,
      locationId: scope.location_id,
      workerId,
      leaseToken: crypto.randomUUID(),
      now: timestamp,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    });
    if (!claim) return { status: "IDLE" };

    const transition = {
      commandId: claim.command.id,
      merchantId: claim.state.merchantId,
      locationId: claim.state.locationId,
      leaseOwner: claim.state.leaseOwner!,
      leaseToken: claim.state.leaseToken!,
      updatedAt: timestamp,
    };
    const block = async (safeErrorCode: GbpSafeErrorCode): Promise<GbpExecutionWorkerResult> => {
      const changed = await markGbpCommandBlockedPreSend(this.deps.db, {
        ...transition, expectedStateVersion: claim.state.stateVersion,
        safeErrorCode, resolvedAt: timestamp,
      });
      return { status: changed ? "BLOCKED_PRE_SEND" : "CLAIM_LOST", commandId: claim.command.id };
    };

    let taskValid = false;
    try { taskValid = await validateTaskDraftAndMedia(this.deps.db, claim); } catch { taskValid = false; }
    if (!taskValid) return block("TASK_DRIFT");
    const binding = await getGbpLocationBinding(this.deps.db, claim.state.merchantId, claim.state.locationId)
      .catch(() => null);
    if (!binding || !sameBinding(claim, binding)) return block("BINDING_DRIFT");

    let client: GbpCoreAiClient;
    try {
      const token = await resolveGbpCredential(this.deps.secretDir, claim.command.command.core.write_secret_ref);
      client = (this.deps.createClient ?? ((options) => createGbpCoreAiClient(options)))({
        baseUrl: this.deps.coreAiBaseUrl,
        token,
        timeoutMs: coreHttpTimeoutMs,
      });
      const identity = await client.getIdentity();
      if (identity.userId !== claim.command.command.core.api_user_id || identity.permissions.length === 0) {
        return block("CONFIG_INVALID");
      }
    } catch {
      return block("CONFIG_INVALID");
    }

    let state = await markGbpCommandTriggering(this.deps.db, {
      ...transition, expectedStateVersion: claim.state.stateVersion,
      triggerStartedAt: timestamp,
    });
    if (!state) return { status: "CLAIM_LOST", commandId: claim.command.id };
    const unknown = async (safeErrorCode: GbpSafeErrorCode): Promise<GbpExecutionWorkerResult> => {
      const changed = await markGbpCommandOutcomeUnknown(this.deps.db, {
        ...transition, expectedStateVersion: state!.stateVersion, safeErrorCode,
      });
      return { status: changed ? "OUTCOME_UNKNOWN" : "CLAIM_LOST", commandId: claim.command.id };
    };

    const input = buildWriteInput(claim);
    let runId: string;
    try {
      const triggered = await client.trigger(claim.command.command.core.write_agent_id, input);
      if (!UuidSchema.safeParse(triggered.runId).success) return unknown("TRIGGER_AMBIGUOUS");
      runId = triggered.runId;
    } catch {
      return unknown("TRIGGER_AMBIGUOUS");
    }
    const triggeringState = state;
    state = await markGbpCommandRunning(this.deps.db, {
      ...transition, expectedStateVersion: state.stateVersion, coreRunId: runId,
    });
    if (!state) {
      state = triggeringState;
      return unknown("CLAIM_LOST");
    }

    const sleep = this.deps.sleep ?? defaultSleep;
    let completedOutput: string | null = null;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      let run;
      try { run = await client.getRun(runId); } catch {
        if (poll + 1 >= maxPolls) return unknown("CORE_RUN_TIMEOUT");
        await sleep(corePollIntervalMs);
        continue;
      }
      if (run.id !== runId || run.agentId !== claim.command.command.core.write_agent_id || run.input !== input) {
        return unknown("RECEIPT_MISMATCH");
      }
      const status = run.status.toUpperCase();
      if (status === "COMPLETED") {
        completedOutput = run.output;
        break;
      }
      if (status === "FAILED") return unknown("CORE_RUN_FAILED");
      if (status === "CANCELLED" || status === "CANCELED") return unknown("CORE_RUN_CANCELLED");
      if (status === "TIMED_OUT" || status === "TIMEOUT") return unknown("CORE_RUN_TIMEOUT");
      if (!RUNNING_STATUSES.has(status)) return unknown("CORE_RUN_FAILED");
      if (poll + 1 < maxPolls) await sleep(corePollIntervalMs);
    }
    if (completedOutput === null) return unknown("CORE_RUN_TIMEOUT");

    let rawReceipt: unknown;
    try { rawReceipt = JSON.parse(completedOutput); } catch { return unknown("RECEIPT_INVALID"); }
    const receipt = GbpExecutionReceiptSchema.safeParse(rawReceipt);
    if (!receipt.success || !["APPLIED", "ALREADY_APPLIED"].includes(receipt.data.status)) {
      return unknown("RECEIPT_INVALID");
    }
    try {
      const finalState = await this.deps.db.withTransaction(async (tx) => {
        await insertGbpReceipt(tx, {
          commandId: claim.command.id,
          merchantId: claim.state.merchantId,
          locationId: claim.state.locationId,
          receipt: receipt.data,
          createdAt: timestamp,
        });
        const accepted = await markGbpCommandReceiptAccepted(tx, {
          ...transition, expectedStateVersion: state!.stateVersion,
        });
        if (!accepted) throw new Error("receipt transition conflict");
        const pending = await markGbpCommandReadbackPending(tx, {
          ...transition, expectedStateVersion: accepted.stateVersion,
        });
        if (!pending) throw new Error("readback transition conflict");
        return pending;
      });
      state = finalState;
      return { status: "READBACK_PENDING", commandId: claim.command.id };
    } catch {
      return unknown("RECEIPT_MISMATCH");
    }
  }
}

/** Functional seam used by focused tests and one-shot jobs. */
export async function runOneGbpExecution(
  deps: GbpExecutionWorkerDeps,
  workerId: string,
  now: Date = new Date(),
): Promise<GbpExecutionWorkerResult> {
  return new GbpExecutionWorker(deps).runOneGbpExecution(workerId, now);
}
