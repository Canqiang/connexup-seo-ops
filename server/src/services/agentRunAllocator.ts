import type { Db } from "../db/connection.js";
import { isUniqueViolation } from "../db/connection.js";
import { ApiError, conflict, notFound } from "../errors.js";
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

async function resolveRequestReplay(
  db: Db,
  idempotencyKey: string,
  merchantId: string,
  httpRequestFingerprint: string,
): Promise<AgentRun | null> {
  const request = await findAgentRunRequestByIdempotencyKey(db, idempotencyKey);
  if (!request) return null;
  if (request.merchantId !== merchantId
    || request.httpRequestFingerprint !== httpRequestFingerprint) {
    throw conflict(
      "idempotency key already used with different Agent Run request semantics",
      "IDEMPOTENCY_CONFLICT",
    );
  }
  const run = await getAgentRun(db, request.runId);
  if (!run) throw new Error(`Agent Run request ${idempotencyKey} references missing Run ${request.runId}`);
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
    createdAt: new Date().toISOString(),
  });
}

export interface AgentRunAllocationInput {
  db: Db;
  run: AgentRun;
  httpRequestFingerprint: string;
  dailyRunLimit?: number;
  /** Called only after the merchant aggregate is locked.  It may converge a
   * business-equivalent request onto an existing generation before quota is
   * evaluated. */
  findBusinessReplay?: (tx: Db) => Promise<AgentRun | null>;
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

      const requestReplay = await resolveRequestReplay(
        tx,
        key,
        input.run.merchantId,
        input.httpRequestFingerprint,
      );
      if (requestReplay) return { run: requestReplay, inserted: false };

      // Compatibility for a Run created before the request ledger migration.
      const idempotent = await findAgentRunByIdempotencyKey(tx, key);
      if (idempotent) {
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

      const replay = await input.findBusinessReplay?.(tx);
      if (replay) {
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
    const replay = await resolveRequestReplay(
      input.db,
      key,
      input.run.merchantId,
      input.httpRequestFingerprint,
    );
    if (!replay) throw error;
    return { run: replay, inserted: false };
  }
}
