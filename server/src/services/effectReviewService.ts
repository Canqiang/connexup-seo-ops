import type { Db } from "../db/connection.js";
import { listMerchants, listMerchantsForOperator } from "../repos/merchantRepo.js";
import { listCycleConfigs } from "../repos/settingsRepo.js";
import { listSpecialistArtifactsByMerchant, type SpecialistArtifact } from "../repos/specialistArtifactRepo.js";

export interface EffectReviewWire {
  artifact_id: string; merchant_id: string; merchant_name: string; task_id: string; core_run_id: string;
  title: string; summary: string; conclusion_tier: string; conclusion: string;
  baseline: Record<string, unknown>; observed_change: Record<string, unknown>;
  action_bundle: Array<Record<string, unknown>>; confounders: string[]; limitations: string[];
  planning_signals: Array<Record<string, unknown>>; acceptance_status: string; created_at: string;
  /** 单店复盘永远为 false：没有对照组就没有因果识别。 */
  causal_identified: false;
}
export interface ReviewWindowWire {
  merchant_id: string; merchant_name: string; review_window_days: number | null;
  last_review_at: string | null; next_window_at: string | null; status: "DUE" | "UPCOMING" | "UNSCHEDULED";
}
export interface EffectReviewsWire {
  summary: { total: number; by_tier: Record<string, number>; due_count: number };
  items: EffectReviewWire[]; windows: ReviewWindowWire[];
}

function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
function records(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object") : []; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

const ALLOWED_CONCLUSION_TIERS = new Set(["INSUFFICIENT_EVIDENCE", "DESCRIPTIVE", "ASSOCIATIONAL"]);
/** 单店复盘结论硬上限 ASSOCIATIONAL：任何产物声称更高等级（如 CAUSAL）一律降级为无法定论，绝不放行。 */
function conclusionTier(value: unknown): string {
  return typeof value === "string" && ALLOWED_CONCLUSION_TIERS.has(value) ? value : "INSUFFICIENT_EVIDENCE";
}

function wire(a: SpecialistArtifact, merchantName: string): EffectReviewWire {
  const p = a.payload;
  return {
    artifact_id: a.id, merchant_id: a.merchantId, merchant_name: merchantName, task_id: a.taskId, core_run_id: a.coreRunId,
    title: a.title, summary: a.summary,
    conclusion_tier: conclusionTier(p.conclusion_tier),
    conclusion: typeof p.conclusion === "string" ? p.conclusion : a.summary,
    baseline: record(p.baseline), observed_change: record(p.observed_change),
    action_bundle: records(p.action_bundle), confounders: strings(p.confounders), limitations: strings(p.limitations),
    planning_signals: records(p.planning_signals), acceptance_status: a.acceptanceStatus, created_at: a.createdAt,
    causal_identified: false,
  };
}

/** 复盘投影：EFFECT_REVIEW 产物按商户聚合；窗口 = 上次复盘 + review_window_days（Gate D）。 */
export async function effectReviews(db: Db, actorUserId: string, scopeAll: boolean, merchantId: string | undefined, now: Date = new Date()): Promise<EffectReviewsWire> {
  const merchants = (scopeAll ? await listMerchants(db) : await listMerchantsForOperator(db, actorUserId)).filter((m) => !merchantId || m.id === merchantId);
  const configs = new Map((await listCycleConfigs(db)).map((c) => [c.merchantId, c]));
  const items: EffectReviewWire[] = [];
  const windows: ReviewWindowWire[] = [];
  for (const merchant of merchants) {
    const artifacts = await listSpecialistArtifactsByMerchant(db, merchant.id, "EFFECT_REVIEW");
    items.push(...artifacts.map((a) => wire(a, merchant.displayName)));
    const last = artifacts[0]?.createdAt ?? null;
    const windowDays = configs.get(merchant.id)?.reviewWindowDays ?? null;
    const next = last && windowDays ? new Date(Date.parse(last) + windowDays * 86_400_000).toISOString() : null;
    windows.push({
      merchant_id: merchant.id, merchant_name: merchant.displayName, review_window_days: windowDays,
      last_review_at: last, next_window_at: next,
      status: !windowDays ? "UNSCHEDULED" : next && Date.parse(next) <= now.getTime() ? "DUE" : "UPCOMING",
    });
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const byTier: Record<string, number> = {};
  for (const item of items) byTier[item.conclusion_tier] = (byTier[item.conclusion_tier] ?? 0) + 1;
  return { summary: { total: items.length, by_tier: byTier, due_count: windows.filter((w) => w.status === "DUE").length }, items, windows };
}
