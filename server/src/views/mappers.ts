import type { GbpLocationBinding, Location, Merchant } from "../repos/types.js";
import type { Task } from "../repos/taskTypes.js";
import type { Questionnaire } from "../repos/questionnaireTypes.js";
import type { Proposal, ProposalBatch } from "../repos/proposalRepo.js";
import type { ExecutionAttempt } from "../repos/executionRepo.js";
import type {
  AgentBinding,
  Capability,
  CycleConfig,
  StyleProfile,
} from "../repos/settingsRepo.js";
import type { ContentDraft } from "../repos/draftRepo.js";
import type { DraftMediaPreview } from "../services/contentService.js";
import type { SpecialistArtifact } from "../repos/specialistArtifactRepo.js";
import type { getGbpExecution } from "../services/gbpExecutionService.js";

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
  execution_mode: string;
  proposal_id: string | null;
  depends_on_task_ids: string[];
  attempt_count: number;
  published_ref: string | null;
  published_at: string | null;
  verify_due_at: string | null;
  verified_at: string | null;
  verified_by: string | null;
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
    execution_mode: t.executionMode,
    proposal_id: t.proposalId,
    depends_on_task_ids: t.dependsOnTaskIds,
    attempt_count: t.attemptCount,
    published_ref: t.publishedRef,
    published_at: t.publishedAt,
    verify_due_at: t.verifyDueAt,
    verified_at: t.verifiedAt,
    verified_by: t.verifiedBy,
    evidence_refs: t.evidenceRefs.map((e) => ({
      id: e.id,
      task_revision: e.taskRevision,
      type: e.type,
      ...(e.artifactId ? { artifact_id: e.artifactId } : {}),
      ...(e.fileId ? { file_id: e.fileId } : {}),
      ...(e.sourceRef ? { source_ref: e.sourceRef } : {}),
      ...(e.sha256 ? { sha256: e.sha256 } : {}),
      ...(e.reusedFromEvidenceId ? { reused_from_evidence_id: e.reusedFromEvidenceId } : {}),
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

// ---------------- 执行域 / 建议层 / 设置 wire views ----------------

export function proposalView(p: Proposal): Record<string, unknown> {
  return {
    id: p.id,
    batch_id: p.batchId,
    merchant_id: p.merchantId,
    location_id: p.locationId,
    seq: p.seq,
    title: p.title,
    task_type: p.taskType,
    execution_mode: p.executionMode,
    executor_agent: p.executorAgent,
    depends_on: p.dependsOn,
    due_at: p.dueAt,
    priority: p.priority,
    impact: p.impact,
    acceptance_criteria: p.acceptanceCriteria,
    execution_spec: p.executionSpec,
    required_evidence_types: p.requiredEvidenceTypes,
    validation_failures: p.validationFailures,
    status: p.status,
    decided_by: p.decidedBy,
    decided_at: p.decidedAt,
    return_reason: p.returnReason,
    task_id: p.taskId,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function proposalBatchView(
  b: ProposalBatch,
  proposals: Proposal[],
  merchantName?: string,
): Record<string, unknown> {
  return {
    id: b.id,
    merchant_id: b.merchantId,
    ...(merchantName ? { merchant_name: merchantName } : {}),
    origin: b.origin,
    trigger_reason: b.triggerReason,
    planner_run_id: b.plannerRunId,
    snapshot_note: b.snapshotNote,
    status: b.status,
    created_by: b.createdBy,
    created_at: b.createdAt,
    updated_at: b.updatedAt,
    proposals: proposals.map(proposalView),
  };
}

export function attemptView(a: ExecutionAttempt): Record<string, unknown> {
  return {
    id: a.id,
    task_id: a.taskId,
    merchant_id: a.merchantId,
    attempt_no: a.attemptNo,
    status: a.status,
    gate: a.gate,
    agent_run_id: a.agentRunId,
    core_run_id: a.coreRunId,
    trace_ref: a.traceRef,
    gbp_command_id: a.gbpCommandId,
    probe_ref: a.probeRef,
    error: a.error,
    started_at: a.startedAt,
    resolved_at: a.resolvedAt,
    resolved_by: a.resolvedBy,
    resolution: a.resolution,
    resolution_note: a.resolutionNote,
  };
}

const GBP_BINDING_FIELDS = [
  "account_resource", "location_resource", "timezone", "core_api_user_id",
  "core_api_user_external_id", "write_secret_ref", "readback_secret_ref",
  "write_agent_id", "write_agent_published_ref", "readback_agent_id",
  "readback_agent_published_ref", "status",
] as const;

function gbpBindingReadiness(
  binding: GbpLocationBinding | null,
  location?: Location | null,
): { ready_for_gate2: boolean; missing_fields: string[]; state_version: number } {
  if (!binding) return {
    ready_for_gate2: false,
    missing_fields: [...GBP_BINDING_FIELDS],
    state_version: 0,
  };
  const exactLocation = Boolean(location
    && location.id === binding.locationId
    && location.merchantId === binding.merchantId
    && location.timezone === binding.timezone
    && Object.values(location.externalIdentities).includes(binding.locationResource));
  const missingFields = binding.status !== "READY"
    ? ["status"]
    : exactLocation ? [] : [
        ...(location?.timezone === binding.timezone ? [] : ["timezone"]),
        ...(location && Object.values(location.externalIdentities).includes(binding.locationResource)
          ? [] : ["location_resource"]),
      ];
  return {
    ready_for_gate2: binding.status === "READY" && exactLocation,
    missing_fields: missingFields,
    state_version: binding.stateVersion,
  };
}

/** Exact location binding projection. Values are logical coordinates and
 * mounted-secret references only; credential material has no domain field. */
export function gbpLocationBindingView(
  binding: GbpLocationBinding | null,
  merchantId: string,
  locationId: string,
  location?: Location | null,
): Record<string, unknown> {
  const readiness = gbpBindingReadiness(binding, location);
  if (!binding) return {
    merchant_id: merchantId, location_id: locationId,
    account_resource: null, location_resource: null, timezone: null,
    core_api_user_id: null, core_api_user_external_id: null,
    write_secret_ref: null, readback_secret_ref: null,
    write_agent_id: null, write_agent_published_ref: null,
    readback_agent_id: null, readback_agent_published_ref: null,
    status: "MISSING", ...readiness, updated_by: null, updated_at: null,
  };
  return {
    merchant_id: binding.merchantId, location_id: binding.locationId,
    account_resource: binding.accountResource, location_resource: binding.locationResource,
    timezone: binding.timezone, core_api_user_id: binding.coreApiUserId,
    core_api_user_external_id: binding.coreApiUserExternalId,
    write_secret_ref: binding.writeSecretRef, readback_secret_ref: binding.readbackSecretRef,
    write_agent_id: binding.writeAgentId,
    write_agent_published_ref: binding.writeAgentPublishedRef,
    readback_agent_id: binding.readbackAgentId,
    readback_agent_published_ref: binding.readbackAgentPublishedRef,
    status: binding.status, ...readiness,
    updated_by: binding.updatedBy, updated_at: binding.updatedAt,
  };
}

export function gbpExecutionView(
  data: NonNullable<Awaited<ReturnType<typeof getGbpExecution>>>,
): Record<string, unknown> {
  if (!data.command) return {
    task_id: data.task.id,
    available: false,
    store: {
      merchant_name: data.merchant?.displayName ?? data.task.merchantId,
      location_name: data.location?.displayName ?? data.task.locationId,
      timezone: data.location?.timezone ?? null,
    },
    approved: {
      body: data.previewDraft.body,
      cta: data.previewDraft.cta,
      image: {
        ...data.previewDraft.image,
        download_path: `/api/seo-ops/deliverables/${encodeURIComponent(data.previewDraft.image.deliverable_id)}/download`,
      },
    },
    hashes: {
      execution_spec: data.task.executionSpecHash,
      draft: data.previewDraft.sha256,
      image: data.previewDraft.image.sha256,
    },
    task_revision: data.task.taskRevision,
    draft_version: data.previewDraft.version,
    binding: gbpBindingReadiness(data.binding, data.location),
  };
  const { command } = data.command;
  return {
    task_id: data.task.id,
    available: true,
    store: {
      merchant_name: data.merchant?.displayName ?? data.task.merchantId,
      location_name: data.location?.displayName ?? data.task.locationId,
      account_resource: command.gbp.account_resource,
      location_resource: command.gbp.location_resource,
      timezone: command.gbp.timezone,
    },
    schedule: { utc: command.scheduled_for, local: command.gbp.scheduled_for_local },
    approved: {
      body: command.draft.body,
      cta: command.draft.cta,
      image: {
        deliverable_id: command.draft.image.deliverable_id,
        sha256: command.draft.image.sha256,
        alt_text: command.draft.image.alt_text,
        download_path: `/api/seo-ops/deliverables/${encodeURIComponent(command.draft.image.deliverable_id)}/download`,
      },
    },
    hashes: {
      command: data.command.commandSha256,
      execution_spec: command.task.execution_spec_sha256,
      draft: command.draft.sha256,
      body: data.bodySha256,
      cta: data.ctaSha256,
      image: data.imageSha256,
    },
    task_revision: command.task.task_revision,
    draft_version: command.draft.version,
    command_state: data.state ? {
      status: data.state.status, state_version: data.state.stateVersion,
      scheduled_for: data.state.scheduledFor, safe_error_code: data.state.safeErrorCode,
      trigger_started_at: data.state.triggerStartedAt, updated_at: data.state.updatedAt,
    } : null,
    receipt: data.receipt ? {
      status: data.receipt.receipt.status,
      provider_mutation_count: data.receipt.receipt.provider_mutation_count,
      created_at: data.receipt.createdAt,
    } : null,
    readbacks: data.readbacks.map((attempt) => ({
      id: attempt.id, diff_codes: attempt.diffCodes,
      safe_error_code: attempt.safeErrorCode, created_at: attempt.createdAt,
    })),
  };
}

export function capabilityView(c: Capability): Record<string, unknown> {
  return {
    id: c.id,
    merchant_id: c.merchantId,
    asset: c.asset,
    capability: c.capability,
    external_ref: c.externalRef,
    tech_connected: c.techConnected,
    merchant_authorized: c.merchantAuthorized,
    status: c.status,
    verified_at: c.verifiedAt,
    verified_by: c.verifiedBy,
    note: c.note,
    updated_at: c.updatedAt,
  };
}

export function cycleConfigView(c: CycleConfig): Record<string, unknown> {
  return {
    merchant_id: c.merchantId,
    snapshot_day: c.snapshotDay,
    post_weekday: c.postWeekday,
    post_per_week: c.postPerWeek,
    review_window_days: c.reviewWindowDays,
    audit_interval_days: c.auditIntervalDays,
    enabled: c.enabled,
    updated_by: c.updatedBy,
    updated_at: c.updatedAt,
  };
}

export function agentBindingView(b: AgentBinding): Record<string, unknown> {
  return {
    task_type: b.taskType,
    agent_id: b.agentId,
    agent_label: b.agentLabel,
    published_ref: b.publishedRef,
    updated_by: b.updatedBy,
    updated_at: b.updatedAt,
  };
}

export function styleProfileView(s: StyleProfile): Record<string, unknown> {
  return {
    id: s.id,
    merchant_id: s.merchantId,
    version: s.version,
    voice: s.voice,
    updated_by: s.updatedBy,
    created_at: s.createdAt,
  };
}

export function draftView(
  d: ContentDraft,
  mediaPreviews: DraftMediaPreview[] = [],
): Record<string, unknown> {
  return {
    id: d.id,
    task_id: d.taskId,
    agent_run_id: d.agentRunId,
    media_source_agent_run_id: d.mediaSourceAgentRunId,
    version: d.version,
    body: d.body,
    cta_type: d.ctaType,
    cta_url: d.ctaUrl,
    media: d.media,
    media_previews: mediaPreviews,
    source: d.source,
    feedback: d.feedback,
    sha256: d.sha256,
    created_by: d.createdBy,
    created_at: d.createdAt,
  };
}

export function specialistArtifactView(a: SpecialistArtifact): Record<string, unknown> {
  return {
    id: a.id,
    task_id: a.taskId,
    merchant_id: a.merchantId,
    artifact_type: a.artifactType,
    schema_version: a.schemaVersion,
    title: a.title,
    summary: a.summary,
    payload: a.payload,
    core_run_id: a.coreRunId,
    created_by: a.createdBy,
    created_at: a.createdAt,
    acceptance_status: a.acceptanceStatus,
    acceptance_decided_by: a.acceptanceDecidedBy,
    acceptance_decided_at: a.acceptanceDecidedAt,
    acceptance_note: a.acceptanceNote,
  };
}
