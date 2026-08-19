import type { Db } from "../db/connection.js";
import { badRequest, notFound } from "../errors.js";
import { listMerchants } from "../repos/merchantRepo.js";
import { listLocations } from "../repos/locationRepo.js";
import { getTask, listTasks } from "../repos/taskRepo.js";
import type { Task } from "../repos/taskTypes.js";

export interface PageResult<T> {
  items: T[];
  offset: number;
  limit: number;
  total: number;
}

export interface PageParams {
  offset?: unknown;
  limit?: unknown;
}

export function parsePageParams(query: PageParams): { offset: number; limit: number } {
  const rawOffset = Number(query.offset ?? 0);
  const rawLimit = Number(query.limit ?? 50);
  if (!Number.isInteger(rawOffset) || rawOffset < 0) {
    throw badRequest("offset must be a non-negative integer");
  }
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    throw badRequest("limit must be an integer between 1 and 100");
  }
  return { offset: rawOffset, limit: rawLimit };
}

export function paginate<T>(all: T[], offset: number, limit: number): PageResult<T> {
  return {
    items: all.slice(offset, offset + limit),
    offset,
    limit,
    total: all.length,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Portfolio

export interface PortfolioResponseWire {
  merchants: Array<{
    id: string;
    slug: string;
    display_name: string;
    operator_user_ids: string[];
    operators: Array<{ id: string; name: string }>;
    owner_ids: string[];
    locations: Array<{ id: string; display_name: string; readiness_status: string }>;
    location_count: number;
    task_count: number;
    ready_for_approval_count: number;
    blocked_count: number;
    overdue_count: number;
    health: "STABLE" | "ATTENTION" | "BLOCKED";
  }>;
  totals: { tasks: number; blocked: number; ready_for_approval: number; overdue: number };
}

function isOverdue(task: Task, now: Date): boolean {
  if (!task.dueAt) return false;
  if (task.status === "APPROVED" || task.status === "APPROVAL_REVOKED") return false;
  return Date.parse(task.dueAt) < now.getTime();
}

export function portfolio(db: Db, now: Date = new Date()): PortfolioResponseWire {
  const merchants = listMerchants(db);
  const locations = listLocations(db);
  const tasks = listTasks(db);

  const totals = { tasks: 0, blocked: 0, ready_for_approval: 0, overdue: 0 };
  const perMerchant = new Map<
    string,
    { tasks: number; ready: number; blocked: number; overdue: number; owners: Set<string> }
  >();

  for (const task of tasks) {
    totals.tasks += 1;
    if (task.status === "BLOCKED") totals.blocked += 1;
    if (task.status === "READY_FOR_APPROVAL") totals.ready_for_approval += 1;
    if (isOverdue(task, now)) totals.overdue += 1;

    const agg =
      perMerchant.get(task.merchantId) ??
      { tasks: 0, ready: 0, blocked: 0, overdue: 0, owners: new Set<string>() };
    agg.tasks += 1;
    if (task.status === "READY_FOR_APPROVAL") agg.ready += 1;
    if (task.status === "BLOCKED") agg.blocked += 1;
    if (isOverdue(task, now)) agg.overdue += 1;
    if (task.ownerId) agg.owners.add(task.ownerId);
    perMerchant.set(task.merchantId, agg);
  }

  const merchantsWire = merchants.map((m) => {
    const agg = perMerchant.get(m.id) ?? {
      tasks: 0, ready: 0, blocked: 0, overdue: 0, owners: new Set<string>(),
    };
    const health: PortfolioResponseWire["merchants"][number]["health"] =
      agg.blocked > 0 ? "BLOCKED"
      : agg.overdue > 0 || agg.ready > 0 ? "ATTENTION"
      : "STABLE";
    return {
      id: m.id,
      slug: m.slug,
      display_name: m.displayName,
      operator_user_ids: m.operatorUserIds,
      operators: m.operatorUserIds.map((id) => ({ id, name: id })),
      owner_ids: [...agg.owners].sort(),
      locations: locations
        .filter((l) => l.merchantId === m.id)
        .map((l) => ({
          id: l.id,
          display_name: l.displayName,
          readiness_status: l.readinessStatus,
        })),
      location_count: locations.filter((l) => l.merchantId === m.id).length,
      task_count: agg.tasks,
      ready_for_approval_count: agg.ready,
      blocked_count: agg.blocked,
      overdue_count: agg.overdue,
      health,
    };
  });

  return { merchants: merchantsWire, totals };
}

// ---------------------------------------------------------------------------
// Inbox

const PRIORITY_RANK: Record<string, number> = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

export interface InboxQuery {
  merchant_id?: unknown;
  location_id?: unknown;
  status?: unknown;
  owner_id?: unknown;
  evidence_state?: unknown;
}

export interface TaskSummaryWire {
  id: string;
  merchant_id: string;
  merchant_name: string;
  location_id?: string;
  location_name?: string;
  title: string;
  task_type: string;
  priority: string;
  impact: string;
  owner_id?: string;
  due_at?: string;
  status: string;
  evidence_state: string;
  task_revision: number;
  state_version: number;
  updated_at: string;
}

export function taskSummary(
  task: Task,
  names: { merchantName: string; locationName?: string },
): TaskSummaryWire {
  return {
    id: task.id,
    merchant_id: task.merchantId,
    merchant_name: names.merchantName,
    ...(task.locationId ? { location_id: task.locationId } : {}),
    ...(names.locationName ? { location_name: names.locationName } : {}),
    title: task.title,
    task_type: task.taskType,
    priority: task.priority,
    impact: task.impact,
    ...(task.ownerId ? { owner_id: task.ownerId } : {}),
    ...(task.dueAt ? { due_at: task.dueAt } : {}),
    status: task.status,
    evidence_state: task.evidenceState,
    task_revision: task.taskRevision,
    state_version: task.stateVersion,
    updated_at: task.updatedAt,
  };
}

function nameLookup(db: Db) {
  const merchants = new Map(listMerchants(db).map((m) => [m.id, m.displayName]));
  const locations = new Map(listLocations(db).map((l) => [l.id, l.displayName]));
  return (task: Task) => ({
    merchantName: merchants.get(task.merchantId) ?? task.merchantId,
    ...(task.locationId && locations.has(task.locationId)
      ? { locationName: locations.get(task.locationId) }
      : {}),
  });
}

export function inbox(
  db: Db,
  query: InboxQuery & PageParams,
): PageResult<TaskSummaryWire> {
  const { offset, limit } = parsePageParams(query);
  const merchantId = str(query.merchant_id);
  const locationId = str(query.location_id);
  const status = str(query.status);
  const ownerId = str(query.owner_id);
  const evidenceState = str(query.evidence_state);

  const names = nameLookup(db);
  const filtered = listTasks(db).filter((t) => {
    if (merchantId && t.merchantId !== merchantId) return false;
    if (locationId && t.locationId !== locationId) return false;
    if (status && t.status !== status) return false;
    if (ownerId && t.ownerId !== ownerId) return false;
    if (evidenceState && t.evidenceState !== evidenceState) return false;
    return true;
  });

  // priority desc -> due_at asc (nulls last) -> updated_at desc
  filtered.sort((a, b) => {
    const pr = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
    if (pr !== 0) return pr;
    if (a.dueAt || b.dueAt) {
      if (!a.dueAt) return 1;
      if (!b.dueAt) return -1;
      const d = Date.parse(a.dueAt) - Date.parse(b.dueAt);
      if (d !== 0) return d;
    }
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });

  return paginate(filtered.map((t) => taskSummary(t, names(t))), offset, limit);
}

// ---------------------------------------------------------------------------
// Task events

export function taskEvents(
  db: Db,
  taskId: string,
  query: PageParams,
): PageResult<Record<string, unknown>> {
  const { offset, limit } = parsePageParams(query);
  const task = getTask(db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  const newestFirst = [...task.events].reverse().map((e) => ({
    id: e.id,
    type: e.type,
    actor_id: e.actorId,
    ...(e.fromStatus ? { from_status: e.fromStatus } : {}),
    ...(e.toStatus ? { to_status: e.toStatus } : {}),
    task_revision: e.taskRevision,
    resulting_state_version: e.resultingStateVersion,
    ...(e.referenceId ? { reference_id: e.referenceId } : {}),
    occurred_at: e.occurredAt,
  }));
  return paginate(newestFirst, offset, limit);
}

// ---------------------------------------------------------------------------
// Reviews (evidence classification projection)

const CAUSAL_TRIPLET = ["BASELINE_MEASUREMENT", "INTERVENTION_RECORD", "POST_MEASUREMENT"];

function classifyEvidence(
  verifiedTypes: Set<string>,
): "FACTUAL" | "CORRELATIONAL" | "CAUSAL_READY" | "INSUFFICIENT_EVIDENCE" {
  const hasTriplet = CAUSAL_TRIPLET.every((t) => verifiedTypes.has(t));
  if (hasTriplet && verifiedTypes.has("CAUSAL_DESIGN")) return "CAUSAL_READY";
  if (hasTriplet) return "CORRELATIONAL";
  if (verifiedTypes.size > 0) return "FACTUAL";
  return "INSUFFICIENT_EVIDENCE";
}

const STRENGTH_BY_CLASS: Record<string, string> = {
  INSUFFICIENT_EVIDENCE: "NONE",
  FACTUAL: "LOW",
  CORRELATIONAL: "MEDIUM",
  CAUSAL_READY: "HIGH",
};

export function reviews(
  db: Db,
  query: PageParams & { merchant_id?: unknown },
): PageResult<Record<string, unknown>> {
  const { offset, limit } = parsePageParams(query);
  const merchantId = str(query.merchant_id);
  const items = listTasks(db)
    .filter((t) => !merchantId || t.merchantId === merchantId)
    .filter((t) => t.evidenceRefs.some((e) => e.taskRevision === t.taskRevision))
    .map((t) => {
      const current = t.evidenceRefs.filter((e) => e.taskRevision === t.taskRevision);
      const verifiedTypes = new Set(
        current.filter((e) => e.verificationStatus === "VERIFIED").map((e) => e.type),
      );
      const classification = classifyEvidence(verifiedTypes);
      return {
        task_id: t.id,
        merchant_id: t.merchantId,
        ...(t.locationId ? { location_id: t.locationId } : {}),
        classification,
        goal: t.title,
        competing_explanations: [],
        conclusion_strength: STRENGTH_BY_CLASS[classification],
        evidence_ids: current.map((e) => e.id),
        updated_at: t.updatedAt,
      };
    })
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  return paginate(items, offset, limit);
}

// ---------------------------------------------------------------------------
// Reports (freshness projection over *_REPORT evidence)

export function reports(
  db: Db,
  query: PageParams & {
    merchant_id?: unknown;
    location_id?: unknown;
    report_type?: unknown;
    captured_from?: unknown;
    captured_to?: unknown;
    freshness?: unknown;
  },
  now: Date = new Date(),
): PageResult<Record<string, unknown>> {
  const { offset, limit } = parsePageParams(query);
  const merchantId = str(query.merchant_id);
  const locationId = str(query.location_id);
  const reportType = str(query.report_type);
  const capturedFrom = str(query.captured_from);
  const capturedTo = str(query.captured_to);
  const freshnessFilter = str(query.freshness);
  for (const [field, value] of [
    ["captured_from", capturedFrom],
    ["captured_to", capturedTo],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw badRequest(`${field} must be an ISO-8601 timestamp`);
    }
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const items = listTasks(db)
    .flatMap((t) =>
      t.evidenceRefs
        .filter((e) => e.type.endsWith("_REPORT"))
        .map((e) => ({ task: t, evidence: e })),
    )
    .map(({ task, evidence }) => {
      const ageDays = (now.getTime() - Date.parse(evidence.capturedAt)) / DAY_MS;
      const freshness = ageDays <= 7 ? "FRESH" : ageDays <= 30 ? "AGING" : "STALE";
      return {
        task_id: task.id,
        merchant_id: task.merchantId,
        ...(task.locationId ? { location_id: task.locationId } : {}),
        evidence_id: evidence.id,
        report_type: evidence.type,
        ...(evidence.artifactId ? { artifact_id: evidence.artifactId } : {}),
        ...(evidence.fileId ? { file_id: evidence.fileId } : {}),
        ...(evidence.sourceRef ? { source_ref: evidence.sourceRef } : {}),
        ...(evidence.sha256 ? { sha256: evidence.sha256 } : {}),
        captured_at: evidence.capturedAt,
        freshness,
      };
    })
    .filter((r) => {
      if (merchantId && r.merchant_id !== merchantId) return false;
      if (locationId && r.location_id !== locationId) return false;
      if (reportType && r.report_type !== reportType) return false;
      if (freshnessFilter && r.freshness !== freshnessFilter) return false;
      if (capturedFrom && Date.parse(r.captured_at) < Date.parse(capturedFrom)) return false;
      if (capturedTo && Date.parse(r.captured_at) > Date.parse(capturedTo)) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));
  return paginate(items, offset, limit);
}
