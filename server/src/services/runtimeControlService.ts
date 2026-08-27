import crypto from "node:crypto";
import type { Db } from "../db/connection.js";
import { ApiError, badRequest } from "../errors.js";
import {
  insertRuntimeControl,
  latestRuntimeControl,
  listRuntimeControls,
  type RuntimeControlRecord,
  type RuntimeControlScope,
} from "../repos/runtimeControlRepo.js";

export interface SetRuntimePauseInput {
  scope: RuntimeControlScope;
  merchantId: string | null;
  paused: boolean;
  reason: string;
  actorId: string;
}

export interface EffectiveRuntimePause {
  paused: boolean;
  source: RuntimeControlScope | null;
  reason: string | null;
  control: RuntimeControlRecord | null;
}

export async function setRuntimePause(
  db: Db,
  input: SetRuntimePauseInput,
): Promise<RuntimeControlRecord> {
  const reason = input.reason.trim();
  if (!reason) throw badRequest("runtime control reason is required");
  if (input.scope === "GLOBAL" && input.merchantId !== null) {
    throw badRequest("global runtime controls cannot include merchant_id");
  }
  if (input.scope === "MERCHANT" && !input.merchantId) {
    throw badRequest("merchant runtime controls require merchant_id");
  }
  const now = new Date().toISOString();
  return insertRuntimeControl(db, {
    id: crypto.randomUUID(),
    scope: input.scope,
    merchantId: input.merchantId,
    paused: input.paused,
    reason,
    changedBy: input.actorId,
    createdAt: now,
  });
}

export async function effectiveRuntimePause(
  db: Db,
  merchantId: string | null = null,
): Promise<EffectiveRuntimePause> {
  const global = await latestRuntimeControl(db, "GLOBAL", null);
  if (global?.paused) {
    return { paused: true, source: "GLOBAL", reason: global.reason, control: global };
  }
  if (merchantId) {
    const merchant = await latestRuntimeControl(db, "MERCHANT", merchantId);
    if (merchant?.paused) {
      return { paused: true, source: "MERCHANT", reason: merchant.reason, control: merchant };
    }
  }
  return { paused: false, source: null, reason: null, control: null };
}

/** Exact request replays may return before this check. A genuinely new
 * allocation must call this from its locked allocation boundary. */
export async function assertRuntimeAcceptsNewWork(
  db: Db,
  merchantId: string,
): Promise<void> {
  const effective = await effectiveRuntimePause(db, merchantId);
  if (!effective.paused) return;
  throw new ApiError(
    409,
    `new work is paused for this merchant: ${effective.reason ?? "operator control"}`,
    "RUNTIME_PAUSED",
  );
}

export function listRuntimeControlHistory(
  db: Db,
  scope: RuntimeControlScope,
  merchantId: string | null,
) {
  return listRuntimeControls(db, scope, merchantId);
}

export async function runtimeControlView(db: Db, merchantId: string | null) {
  const [global, merchant, effective] = await Promise.all([
    latestRuntimeControl(db, "GLOBAL", null),
    merchantId ? latestRuntimeControl(db, "MERCHANT", merchantId) : null,
    effectiveRuntimePause(db, merchantId),
  ]);
  return { global, merchant, effective };
}
