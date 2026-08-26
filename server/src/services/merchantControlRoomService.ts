import { z } from "zod";
import type { Db } from "../db/connection.js";
import {
  listCycleLedgerProposals,
  listPendingGbpPostProposals,
  listProposalDependencyLabels,
} from "../repos/proposalRepo.js";
import {
  listPostProgramArtifacts,
  type PostProgramArtifactRow,
} from "../repos/specialistArtifactRepo.js";
import { getActiveMerchantCycle } from "../repos/merchantCycleRepo.js";
import { latestStyleProfile } from "../repos/settingsRepo.js";
import {
  listCycleLedgerTasks,
  listVerifiedGbpPostHistory,
} from "../repos/taskRepo.js";

export interface CycleLedgerItem {
  record_kind: "TASK" | "PROPOSAL";
  task_id: string | null;
  proposal_id: string | null;
  title: string;
  task_type: string;
  priority: string | null;
  owner_id: string | null;
  due_at: string | null;
  created_at: string;
  status: string;
  execution_mode: string;
  dependency_labels: string[];
  validation_failures: string[];
}

export interface CycleLedgerView {
  items: CycleLedgerItem[];
}

export interface PostProgramView {
  voice_profile: {
    version: number;
    summary: Array<{
      key: "tone" | "address" | "banned" | "example" | "source";
      label: string;
      value: string;
    }>;
    created_at: string;
  } | null;
  cluster_signals: Array<{
    artifact_id: string;
    task_id: string;
    cluster: string;
    signal: "IMPROVED" | "FLAT" | "DECLINED" | "INCONCLUSIVE";
    observed_at: string;
    evidence_ref: string | null;
  }>;
  history: Array<{
    task_id: string;
    title: string;
    published_ref: string;
    published_at: string;
    verified_at: string;
    verified_by: string | null;
  }>;
  proposals: Array<{
    proposal_id: string;
    title: string;
    due_at: string | null;
    priority: string;
    status: "PENDING" | "VALIDATION_FAILED";
    validation_failures: string[];
  }>;
  evidence_gaps: string[];
}

const voiceSchema = z.record(z.unknown()).refine(
  (voice) => Object.keys(voice).length > 0,
  "voice profile must contain an explicit field",
);

const voiceSummaryFields = [
  ["tone", "语气"],
  ["address", "称呼"],
  ["banned", "禁用表达"],
  ["example", "示例"],
  ["source", "来源"],
] as const;

function summaryValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim())) {
    return value.map((item) => item.trim()).join("、");
  }
  return null;
}

function voiceSummary(voice: Record<string, unknown>): NonNullable<PostProgramView["voice_profile"]>["summary"] {
  return voiceSummaryFields.flatMap(([key, label]) => {
    const value = summaryValue(voice[key]);
    return value ? [{ key, label, value }] : [];
  });
}

const clusterSignalSchema = z.object({
  cluster: z.string().trim().min(1).max(300),
  signal: z.enum(["IMPROVED", "FLAT", "DECLINED", "INCONCLUSIVE"]),
  evidence_ref: z.string().trim().min(1).max(1000).optional(),
}).strict();

const keywordWeeklyArtifactSchema = z.object({
  schema_version: z.literal("seo_ops.keyword_weekly_signal.v1"),
  merchant_id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(4000),
  observed_at: z.string().datetime({ offset: true }),
  cluster_signals: z.array(clusterSignalSchema).min(1).max(100),
}).strict();

function sortDated(items: CycleLedgerItem[]): CycleLedgerItem[] {
  return [...items].sort((left, right) => {
    const byDue = (left.due_at ?? "9999-12-31T23:59:59.999Z")
      .localeCompare(right.due_at ?? "9999-12-31T23:59:59.999Z");
    if (byDue !== 0) return byDue;
    const byCreated = left.created_at.localeCompare(right.created_at);
    if (byCreated !== 0) return byCreated;
    return (left.task_id ?? left.proposal_id ?? "")
      .localeCompare(right.task_id ?? right.proposal_id ?? "");
  });
}

/** A merchant-scoped, date-ordered ledger.  Task and proposal state is never
 * collapsed: adoption is the only path that allows a proposal to appear as a
 * Task, and pending/invalid proposals retain their own distinct row. */
export async function cycleLedger(
  db: Db,
  merchantId: string,
): Promise<CycleLedgerView> {
  const activeCycle = await getActiveMerchantCycle(db, merchantId);
  if (!activeCycle) return { items: [] };
  const [tasks, proposals] = await Promise.all([
    listCycleLedgerTasks(db, merchantId, activeCycle.id),
    listCycleLedgerProposals(db, merchantId, activeCycle.id),
  ]);
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title]));
  const proposalLabels = await listProposalDependencyLabels(
    db,
    merchantId,
    [...new Set(proposals.map((proposal) => proposal.batchId))],
  );
  const proposalTitles = new Map(
    proposalLabels.map((proposal) => [`${proposal.batchId}:${proposal.seq}`, proposal.title]),
  );

  return {
    items: sortDated([
      ...tasks.map((task): CycleLedgerItem => ({
        record_kind: "TASK",
        task_id: task.id,
        proposal_id: task.proposalId,
        title: task.title,
        task_type: task.taskType,
        priority: null,
        owner_id: task.ownerId,
        due_at: task.dueAt,
        created_at: task.createdAt,
        status: task.status,
        execution_mode: task.executionMode,
        dependency_labels: task.dependsOnTaskIds.map(
          (id) => taskTitles.get(id) ?? `Task ${id}`,
        ),
        validation_failures: [],
      })),
      ...proposals.map((proposal): CycleLedgerItem => ({
        record_kind: "PROPOSAL",
        task_id: null,
        proposal_id: proposal.id,
        title: proposal.title,
        task_type: proposal.taskType,
        priority: proposal.priority,
        owner_id: null,
        due_at: proposal.dueAt,
        created_at: proposal.createdAt,
        status: proposal.status,
        execution_mode: proposal.executionMode,
        dependency_labels: proposal.dependsOn.map(
          (seq) => proposalTitles.get(`${proposal.batchId}:${seq}`) ?? `Proposal #${seq}`,
        ),
        validation_failures: proposal.validationFailures,
      })),
    ]),
  };
}

function signalsFromArtifact(
  artifact: PostProgramArtifactRow,
  merchantId: string,
): PostProgramView["cluster_signals"] | null {
  const parsed = keywordWeeklyArtifactSchema.safeParse(artifact.payload);
  if (!parsed.success || parsed.data.merchant_id !== merchantId || parsed.data.schema_version !== artifact.schemaVersion) {
    return null;
  }
  return parsed.data.cluster_signals.map((signal) => ({
    artifact_id: artifact.id,
    task_id: artifact.taskId,
    cluster: signal.cluster,
    signal: signal.signal,
    observed_at: parsed.data.observed_at,
    evidence_ref: signal.evidence_ref ?? null,
  }));
}

/** Post-program truth is deliberately conservative.  It is composed solely
 * from persisted voice records, validated specialist artifacts, and Task
 * publication/verification fields; it never turns a generated topic or an
 * Agent run into merchant-facing evidence. */
export async function postProgram(
  db: Db,
  merchantId: string,
): Promise<PostProgramView> {
  const activeCycle = await getActiveMerchantCycle(db, merchantId);
  const [profile, artifacts, history, proposals] = await Promise.all([
    latestStyleProfile(db, merchantId),
    activeCycle ? listPostProgramArtifacts(db, merchantId, activeCycle.id) : [],
    listVerifiedGbpPostHistory(db, merchantId),
    activeCycle ? listPendingGbpPostProposals(db, merchantId, activeCycle.id) : [],
  ]);
  const gaps = new Set<string>();
  const parsedVoice = profile ? voiceSchema.safeParse(profile.voice) : null;
  const summary = parsedVoice?.success ? voiceSummary(parsedVoice.data) : [];
  const voiceProfile = profile && parsedVoice?.success && summary.length
    ? { version: profile.version, summary, created_at: profile.createdAt }
    : null;
  if (!voiceProfile) gaps.add(profile ? parsedVoice?.success ? "VOICE_PROFILE_NO_ALLOWLISTED_FIELDS" : "INVALID_VOICE_PROFILE_ARTIFACT" : "VOICE_PROFILE_MISSING");

  let clusterSignals: PostProgramView["cluster_signals"] = [];
  for (const artifact of artifacts) {
    const signals = signalsFromArtifact(artifact, merchantId);
    if (signals) {
      clusterSignals = signals;
      break;
    }
    gaps.add(`INVALID_${artifact.artifactType}_ARTIFACT`);
  }
  if (clusterSignals.length === 0) gaps.add("CLUSTER_SIGNAL_MISSING");
  // Signal type and coverage are not durable properties of the persisted
  // weekly-signal artifact.  Surface that absence instead of inferring a fact.
  gaps.add("POST_SIGNAL_TYPE_MISSING");
  gaps.add("POST_SIGNAL_COVERAGE_MISSING");
  if (history.length === 0) gaps.add("POST_HISTORY_MISSING");
  if (proposals.length === 0) gaps.add("POST_PROPOSAL_MISSING");

  return {
    voice_profile: voiceProfile,
    cluster_signals: clusterSignals,
    history: history.map((task) => ({
      task_id: task.id,
      title: task.title,
      published_ref: task.publishedRef,
      published_at: task.publishedAt,
      verified_at: task.verifiedAt,
      verified_by: task.verifiedBy,
    })),
    proposals: proposals.map((proposal) => ({
      proposal_id: proposal.id,
      title: proposal.title,
      due_at: proposal.dueAt,
      priority: proposal.priority,
      status: proposal.status,
      validation_failures: proposal.validationFailures,
    })),
    evidence_gaps: [...gaps].sort(),
  };
}
