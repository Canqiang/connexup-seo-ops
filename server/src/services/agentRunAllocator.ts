import type { Db } from "../db/connection.js";
import { isUniqueViolation } from "../db/connection.js";
import { ApiError, conflict, notFound } from "../errors.js";
import {
  agentRunScopeReconciliationRequired,
  assertAgentRunTaskScope,
  type AgentRunTaskScope,
} from "../domain/agentRunScope.js";
import {
  CURRENT_AGENT_RUN_REQUEST_SEMANTICS,
  LEGACY_BOUND_AGENT_RUN_REQUEST_SEMANTICS,
} from "../domain/agentRunRequestSemantics.js";
import {
  countAgentRunsByMerchantSince,
  findAgentRunByIdempotencyKey,
  findAgentRunRequestByIdempotencyKey,
  getAgentRun,
  insertAgentRun,
  insertAgentRunRequest,
} from "../repos/agentRunRepo.js";
import type { AgentRun } from "../repos/agentRunTypes.js";
import { lockMerchantForUpdate } from "../repos/merchantRepo.js";

const DEFAULT_DAILY_RUN_LIMIT = 20;

function startOfUtcDayIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function persistedHttpSemantics(run: AgentRun): string | null {
  return run.httpRequestFingerprint ?? run.requestFingerprint;
}

export async function resolveAgentRunRequestReplay(
  db: Db,
  idempotencyKey: string,
  httpRequestFingerprint: string,
  expected: { merchantId?: string; taskId?: string; locationId?: string | null } = {},
): Promise<AgentRun | null> {
  const request = await findAgentRunRequestByIdempotencyKey(db, idempotencyKey);
  if (!request) return null;
  if (expected.merchantId !== undefined && request.merchantId !== expected.merchantId) {
    agentRunScopeReconciliationRequired();
  }
  if (request.semanticsVersion !== CURRENT_AGENT_RUN_REQUEST_SEMANTICS
    && request.semanticsVersion !== LEGACY_BOUND_AGENT_RUN_REQUEST_SEMANTICS) {
    agentRunScopeReconciliationRequired();
  }
  const usesLegacyBoundGbpReplay = request.semanticsVersion
    === LEGACY_BOUND_AGENT_RUN_REQUEST_SEMANTICS && expected.taskId !== undefined;
  if (!usesLegacyBoundGbpReplay && request.httpRequestFingerprint !== httpRequestFingerprint) {
    throw conflict(
      "idempotency key already used with different Agent Run request semantics",
      "IDEMPOTENCY_CONFLICT",
    );
  }
  const run = await getAgentRun(db, request.runId);
  if (!run) agentRunScopeReconciliationRequired();
  if (expected.taskId !== undefined) {
    if (expected.merchantId === undefined || expected.locationId === undefined) {
      throw new Error("task-linked Agent Run replay requires merchant and location scope");
    }
    assertAgentRunTaskScope(run, {
      taskId: expected.taskId,
      merchantId: expected.merchantId,
      locationId: expected.locationId,
    });
    if (request.semanticsVersion === LEGACY_BOUND_AGENT_RUN_REQUEST_SEMANTICS
      && run.stage !== "GBP_POST_CONTENT") {
      agentRunScopeReconciliationRequired();
    }
  }
  return run;
}

async function persistRequestAlias(
  db: Db,
  run: AgentRun,
  idempotencyKey: string,
  httpRequestFingerprint: string,
): Promise<void> {
  await insertAgentRunRequest(db, {
    idempotencyKey,
    runId: run.id,
    merchantId: run.merchantId,
    httpRequestFingerprint,
    semanticsVersion: CURRENT_AGENT_RUN_REQUEST_SEMANTICS,
    createdAt: new Date().toISOString(),
  });
}

export interface AgentRunAllocationInput {
  db: Db;
  run: AgentRun;
  httpRequestFingerprint: string;
  dailyRunLimit?: number;
  expectedReplayScope?: AgentRunTaskScope;
  /** Called only after the merchant aggregate is locked.  It may converge a
   * business-equivalent request onto an existing generation before quota is
   * evaluated. */
  findBusinessReplay?: (tx: Db) => Promise<AgentRun | null>;
  /** Revalidate mutable aggregate state only for a genuinely new allocation.
   * Exact HTTP replays have already returned before this callback runs. */
  validateBeforeInsert?: (tx: Db) => Promise<void>;
}

/** The only allocation boundary for SEO Agent Runs.  It serializes every
 * writer by merchant, resolves idempotent/business replay before quota, and
 * commits the durable TRIGGERING row before any caller performs network I/O. */
export async function allocateAgentRun(
  input: AgentRunAllocationInput,
): Promise<{ run: AgentRun; inserted: boolean }> {
  const key = input.run.creationIdempotencyKey!;
  try {
    return await input.db.withTransaction(async (tx) => {
      if (!await lockMerchantForUpdate(tx, input.run.merchantId)) {
        throw notFound(`merchant ${input.run.merchantId} not found`);
      }

      const requestReplay = await resolveAgentRunRequestReplay(
        tx,
        key,
        input.httpRequestFingerprint,
        input.expectedReplayScope ?? { merchantId: input.run.merchantId },
      );
      if (requestReplay) return { run: requestReplay, inserted: false };

      // Compatibility for a Run created before the request ledger migration.
      const idempotent = await findAgentRunByIdempotencyKey(tx, key);
      if (idempotent) {
        if (input.expectedReplayScope) {
          assertAgentRunTaskScope(idempotent, input.expectedReplayScope);
        }
        if (idempotent.merchantId !== input.run.merchantId
          || persistedHttpSemantics(idempotent) !== input.httpRequestFingerprint) {
          throw conflict(
            "idempotency key already used with different Agent Run request semantics",
            "IDEMPOTENCY_CONFLICT",
          );
        }
        await persistRequestAlias(tx, idempotent, key, input.httpRequestFingerprint);
        return { run: idempotent, inserted: false };
      }

      await input.validateBeforeInsert?.(tx);

      const replay = await input.findBusinessReplay?.(tx);
      if (replay) {
        if (input.expectedReplayScope) {
          assertAgentRunTaskScope(replay, input.expectedReplayScope);
        }
        await persistRequestAlias(tx, replay, key, input.httpRequestFingerprint);
        return { run: replay, inserted: false };
      }

      const limit = input.dailyRunLimit ?? DEFAULT_DAILY_RUN_LIMIT;
      if ((await countAgentRunsByMerchantSince(
        tx,
        input.run.merchantId,
        startOfUtcDayIso(),
      )) >= limit) {
        throw new ApiError(
          429,
          `merchant ${input.run.merchantId} reached the daily run limit (${limit})`,
          "RUN_LIMIT_REACHED",
        );
      }

      await insertAgentRun(tx, input.run);
      await persistRequestAlias(tx, input.run, key, input.httpRequestFingerprint);
      return { run: input.run, inserted: true };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const replay = await resolveAgentRunRequestReplay(
      input.db,
      key,
      input.httpRequestFingerprint,
      input.expectedReplayScope ?? { merchantId: input.run.merchantId },
    );
    if (!replay) throw error;
    return { run: replay, inserted: false };
  }
}
