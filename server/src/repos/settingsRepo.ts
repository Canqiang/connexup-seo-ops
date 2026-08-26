import type { Db } from "../db/connection.js";
import type { CapabilityStatus } from "../domain/enums.js";

// ---------------- 能力矩阵 ----------------

export interface Capability {
  id: string;
  merchantId: string;
  asset: string;
  capability: string;
  externalRef: string | null;
  techConnected: boolean;
  merchantAuthorized: boolean;
  status: CapabilityStatus;
  verifiedAt: string | null;
  verifiedBy: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CapabilityRow {
  id: string; merchant_id: string; asset: string; capability: string;
  external_ref: string | null; tech_connected: boolean; merchant_authorized: boolean;
  status: string; verified_at: string | null; verified_by: string | null;
  note: string | null; created_at: string; updated_at: string;
}

function toCapability(row: CapabilityRow): Capability {
  return {
    id: row.id, merchantId: row.merchant_id, asset: row.asset,
    capability: row.capability, externalRef: row.external_ref,
    techConnected: row.tech_connected, merchantAuthorized: row.merchant_authorized,
    status: row.status as CapabilityStatus, verifiedAt: row.verified_at,
    verifiedBy: row.verified_by, note: row.note,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** 三层推导：未连接 -> MISSING；已连接未授权 -> BLOCKED；都齐 -> ACTIVE。 */
export function deriveCapabilityStatus(techConnected: boolean, merchantAuthorized: boolean): CapabilityStatus {
  if (!techConnected) return "MISSING";
  if (!merchantAuthorized) return "BLOCKED";
  return "ACTIVE";
}

export async function upsertCapability(db: Db, c: Capability): Promise<Capability> {
  await db.exec(
    `INSERT INTO seo_capabilities
      (id, merchant_id, asset, capability, external_ref, tech_connected,
       merchant_authorized, status, verified_at, verified_by, note, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (merchant_id, capability) DO UPDATE SET
       asset = EXCLUDED.asset, external_ref = EXCLUDED.external_ref,
       tech_connected = EXCLUDED.tech_connected,
       merchant_authorized = EXCLUDED.merchant_authorized,
       status = EXCLUDED.status, verified_at = EXCLUDED.verified_at,
       verified_by = EXCLUDED.verified_by, note = EXCLUDED.note,
       updated_at = EXCLUDED.updated_at`,
    [c.id, c.merchantId, c.asset, c.capability, c.externalRef, c.techConnected,
     c.merchantAuthorized, c.status, c.verifiedAt, c.verifiedBy, c.note,
     c.createdAt, c.updatedAt],
  );
  return c;
}

export async function getCapability(
  db: Db,
  merchantId: string,
  capability: string,
): Promise<Capability | null> {
  const row = await db.one<CapabilityRow>(
    `SELECT * FROM seo_capabilities WHERE merchant_id = $1 AND capability = $2`,
    [merchantId, capability],
  );
  return row ? toCapability(row) : null;
}

export async function listCapabilities(db: Db, merchantId?: string): Promise<Capability[]> {
  const rows = merchantId
    ? await db.query<CapabilityRow>(
        `SELECT * FROM seo_capabilities WHERE merchant_id = $1 ORDER BY asset, capability`, [merchantId])
    : await db.query<CapabilityRow>(`SELECT * FROM seo_capabilities ORDER BY merchant_id, asset, capability`);
  return rows.map(toCapability);
}

// ---------------- 周期配置（Ⓐ 级预授权） ----------------

export interface CycleConfig {
  merchantId: string;
  /** 每月第几天出快照+表现报告（含 LF 扫描）；null = 关闭。 */
  snapshotDay: number | null;
  /** 每周几出 Post 任务（0=周日…6=周六）；null = 暂停。 */
  postWeekday: number | null;
  postPerWeek: number;
  reviewWindowDays: number;
  auditIntervalDays: number | null;
  enabled: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CycleRow {
  merchant_id: string; snapshot_day: number | null; post_weekday: number | null;
  post_per_week: number; review_window_days: number; audit_interval_days: number | null;
  enabled: boolean; updated_by: string | null; created_at: string; updated_at: string;
}

function toCycle(row: CycleRow): CycleConfig {
  return {
    merchantId: row.merchant_id, snapshotDay: row.snapshot_day,
    postWeekday: row.post_weekday, postPerWeek: row.post_per_week,
    reviewWindowDays: row.review_window_days, auditIntervalDays: row.audit_interval_days,
    enabled: row.enabled, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function upsertCycleConfig(db: Db, c: CycleConfig): Promise<CycleConfig> {
  await db.exec(
    `INSERT INTO seo_cycle_configs
      (merchant_id, snapshot_day, post_weekday, post_per_week, review_window_days,
       audit_interval_days, enabled, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (merchant_id) DO UPDATE SET
       snapshot_day = EXCLUDED.snapshot_day, post_weekday = EXCLUDED.post_weekday,
       post_per_week = EXCLUDED.post_per_week, review_window_days = EXCLUDED.review_window_days,
       audit_interval_days = EXCLUDED.audit_interval_days, enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [c.merchantId, c.snapshotDay, c.postWeekday, c.postPerWeek, c.reviewWindowDays,
     c.auditIntervalDays, c.enabled, c.updatedBy, c.createdAt, c.updatedAt],
  );
  return c;
}

export async function getCycleConfig(db: Db, merchantId: string): Promise<CycleConfig | null> {
  const row = await db.one<CycleRow>(
    `SELECT * FROM seo_cycle_configs WHERE merchant_id = $1`, [merchantId]);
  return row ? toCycle(row) : null;
}

export async function listCycleConfigs(db: Db): Promise<CycleConfig[]> {
  const rows = await db.query<CycleRow>(`SELECT * FROM seo_cycle_configs ORDER BY merchant_id`);
  return rows.map(toCycle);
}

// ---------------- Agent 绑定（taskType → published agent） ----------------

export interface AgentBinding {
  taskType: string;
  agentId: string;
  agentLabel: string | null;
  publishedRef: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BindingRow {
  task_type: string; agent_id: string; agent_label: string | null;
  published_ref: string | null; updated_by: string | null;
  created_at: string; updated_at: string;
}

function toBinding(row: BindingRow): AgentBinding {
  return {
    taskType: row.task_type, agentId: row.agent_id, agentLabel: row.agent_label,
    publishedRef: row.published_ref, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export async function upsertAgentBinding(db: Db, b: AgentBinding): Promise<AgentBinding> {
  await db.exec(
    `INSERT INTO seo_agent_bindings
      (task_type, agent_id, agent_label, published_ref, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (task_type) DO UPDATE SET
       agent_id = EXCLUDED.agent_id, agent_label = EXCLUDED.agent_label,
       published_ref = EXCLUDED.published_ref, updated_by = EXCLUDED.updated_by,
       updated_at = EXCLUDED.updated_at`,
    [b.taskType, b.agentId, b.agentLabel, b.publishedRef, b.updatedBy, b.createdAt, b.updatedAt],
  );
  return b;
}

export async function getAgentBinding(db: Db, taskType: string): Promise<AgentBinding | null> {
  const row = await db.one<BindingRow>(
    `SELECT * FROM seo_agent_bindings WHERE task_type = $1`, [taskType]);
  return row ? toBinding(row) : null;
}

export async function listAgentBindings(db: Db): Promise<AgentBinding[]> {
  const rows = await db.query<BindingRow>(`SELECT * FROM seo_agent_bindings ORDER BY task_type`);
  return rows.map(toBinding);
}

// ---------------- 风格档案 ----------------

export interface StyleProfile {
  id: string;
  merchantId: string;
  version: number;
  /** {tone, address, banned[], example, source} —— 品牌档案 voice + 人工校订。 */
  voice: Record<string, unknown>;
  updatedBy: string | null;
  createdAt: string;
}

interface StyleRow {
  id: string; merchant_id: string; version: number; voice: string;
  updated_by: string | null; created_at: string;
}

function toStyle(row: StyleRow): StyleProfile {
  return {
    id: row.id, merchantId: row.merchant_id, version: row.version,
    voice: JSON.parse(row.voice || "{}"), updatedBy: row.updated_by,
    createdAt: row.created_at,
  };
}

export async function insertStyleProfile(db: Db, s: StyleProfile): Promise<StyleProfile> {
  await db.exec(
    `INSERT INTO seo_style_profiles (id, merchant_id, version, voice, updated_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [s.id, s.merchantId, s.version, JSON.stringify(s.voice), s.updatedBy, s.createdAt],
  );
  return s;
}

export async function latestStyleProfile(db: Db, merchantId: string): Promise<StyleProfile | null> {
  const row = await db.one<StyleRow>(
    `SELECT * FROM seo_style_profiles WHERE merchant_id = $1 ORDER BY version DESC LIMIT 1`,
    [merchantId],
  );
  return row ? toStyle(row) : null;
}
