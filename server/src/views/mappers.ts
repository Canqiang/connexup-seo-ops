import type { Location, Merchant } from "../repos/types.js";
import type { Task } from "../repos/taskTypes.js";
import type { Questionnaire } from "../repos/questionnaireTypes.js";

/** Wire views — snake_case shapes that match the frontend types in
 * `src/api/types.ts` exactly. */
export interface MerchantView {
  id: string;
  slug: string;
  display_name: string;
  tags: string[];
  operator_user_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface LocationView {
  id: string;
  merchant_id: string;
  slug: string;
  display_name: string;
  timezone: string | null;
  external_identities: Record<string, string>;
  readiness_status: string;
  missing_requirements: string[];
  created_at: string;
  updated_at: string;
}

export function merchantView(m: Merchant): MerchantView {
  return {
    id: m.id,
    slug: m.slug,
    display_name: m.displayName,
    tags: m.tags,
    operator_user_ids: m.operatorUserIds,
    created_at: m.createdAt,
    updated_at: m.updatedAt,
  };
}

export function locationView(l: Location): LocationView {
  return {
    id: l.id,
    merchant_id: l.merchantId,
    slug: l.slug,
    display_name: l.displayName,
    timezone: l.timezone,
    external_identities: l.externalIdentities,
    readiness_status: l.readinessStatus,
    missing_requirements: l.missingRequirements,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

export interface QuestionnaireView {
  id: string;
  merchant_id: string;
  status: string;
  share_slug: string;
  base_info: Record<string, string>;
  questions: Array<{ id: string; question: string; hint?: string; required: boolean }>;
  answers: Record<string, string> | null;
  send_count: number;
  sent_at: string | null;
  last_sent_at: string | null;
  last_sent_by: string | null;
  filled_at: string | null;
  created_at: string;
  updated_at: string;
}

export function questionnaireView(q: Questionnaire): QuestionnaireView {
  return {
    id: q.id,
    merchant_id: q.merchantId,
    status: q.status,
    share_slug: q.shareSlug,
    base_info: q.baseInfo,
    questions: q.questions,
    answers: q.answers,
    send_count: q.sendCount,
    sent_at: q.sentAt,
    last_sent_at: q.lastSentAt,
    last_sent_by: q.lastSentBy,
    filled_at: q.filledAt,
    created_at: q.createdAt,
    updated_at: q.updatedAt,
  };
}

export interface SeoTaskView {
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
  source: string;
  execution_spec: string;
  execution_spec_hash: string;
  required_evidence_types: string[];
  evidence_refs: Array<Record<string, unknown>>;
  approval_decisions: Array<Record<string, unknown>>;
  conversation_links: Array<Record<string, unknown>>;
  agent_run_links: Array<Record<string, unknown>>;
  created_at: string;
}

export function taskView(
  t: Task,
  names: { merchantName: string; locationName?: string },
): SeoTaskView {
  return {
    id: t.id,
    merchant_id: t.merchantId,
    merchant_name: names.merchantName,
    ...(t.locationId ? { location_id: t.locationId } : {}),
    ...(names.locationName ? { location_name: names.locationName } : {}),
    title: t.title,
    task_type: t.taskType,
    priority: t.priority,
    impact: t.impact,
    ...(t.ownerId ? { owner_id: t.ownerId } : {}),
    ...(t.dueAt ? { due_at: t.dueAt } : {}),
    status: t.status,
    evidence_state: t.evidenceState,
    task_revision: t.taskRevision,
    state_version: t.stateVersion,
    updated_at: t.updatedAt,
    source: t.source,
    execution_spec: t.executionSpec,
    execution_spec_hash: t.executionSpecHash,
    required_evidence_types: t.requiredEvidenceTypes,
    evidence_refs: t.evidenceRefs.map((e) => ({
      id: e.id,
      task_revision: e.taskRevision,
      type: e.type,
      ...(e.artifactId ? { artifact_id: e.artifactId } : {}),
      ...(e.fileId ? { file_id: e.fileId } : {}),
      ...(e.sourceRef ? { source_ref: e.sourceRef } : {}),
      ...(e.sha256 ? { sha256: e.sha256 } : {}),
      captured_at: e.capturedAt,
      verification_status: e.verificationStatus,
      requirement_key: e.requirementKey,
      created_by: e.createdBy,
      created_at: e.createdAt,
    })),
    approval_decisions: t.approvalDecisions.map((d) => ({
      id: d.id,
      decision: d.decision,
      ...(d.reason ? { reason: d.reason } : {}),
      task_revision: d.taskRevision,
      execution_spec_hash: d.executionSpecHash,
      expected_state_version: d.expectedStateVersion,
      resulting_state_version: d.resultingStateVersion,
      actor_id: d.actorId,
      decided_at: d.decidedAt,
    })),
    conversation_links: t.conversationLinks.map((c) => ({
      conversation_id: c.conversationId,
      relationship: c.relationship,
      linked_by: c.linkedBy,
      linked_at: c.linkedAt,
    })),
    agent_run_links: t.agentRunLinks.map((a) => ({
      agent_run_id: a.agentRunId,
      relationship: a.relationship,
      ...(a.status ? { status: a.status } : {}),
      linked_by: a.linkedBy,
      linked_at: a.linkedAt,
    })),
    created_at: t.createdAt,
  };
}
