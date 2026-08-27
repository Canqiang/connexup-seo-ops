import { requestJson } from "./client";
import type {
  ActivityFeedView, AgentBindingWire, AppendEvidenceRequest, ApprovalDecisionRequest, ApprovalPreview, AttemptWire,
  CapabilityWire, CreateRevisionRequest, CreateTaskRequest, CycleConfigWire, GbpExecutionWire, GbpLocationBindingWire,
  CycleLedgerView, DeliverableWire, DraftWire, ExecutionPreviewWire, InboxSummaryWire, LifecycleView, LocationView,
  ManualDeliverableRequest, MerchantOnboardingView, Page, PortfolioResponse, ProposalBatchWire, ProposalWire,
  PostProgramView, QuestionnaireItemWire, QuestionnaireStatus, QuestionnaireView, RankingOverviewView, ReportItem, ReviewItem, RuntimeConfig,
  RuntimeControlsView, RuntimeControlWire, RunsLedgerRequest, RunsLedgerView,
  SchedulerTickResult, SeoOpsPageRequest, SeoTask, SpecialistArtifactType, SpecialistArtifactWire,
  StageRunView, TaskAuditReferencesWire, TaskEvent, TaskSummary, TriggerStageRunRequest, WorkbenchRequest, WorkbenchView
} from "./types";

function query(request: SeoOpsPageRequest = {}): string {
  const params = new URLSearchParams();
  Object.entries(request).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const value = params.toString();
  return value ? `?${value}` : "";
}

function post<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export const seoOpsApi = {
  config: (signal?: AbortSignal) => requestJson<RuntimeConfig>("/api/seo-ops/config", { signal }),
  portfolio: (signal?: AbortSignal) => requestJson<PortfolioResponse>("/api/seo-ops/portfolio", { signal }),
  inbox: (request: SeoOpsPageRequest = {}, signal?: AbortSignal) =>
    requestJson<Page<TaskSummary>>(`/api/seo-ops/inbox${query(request)}`, { signal }),
  workbench: (request: WorkbenchRequest = {}, signal?: AbortSignal) =>
    requestJson<WorkbenchView>(`/api/seo-ops/workbench${query(request)}`, { signal }),
  reviews: (request: SeoOpsPageRequest = {}, signal?: AbortSignal) =>
    requestJson<Page<ReviewItem>>(`/api/seo-ops/reviews${query(request)}`, { signal }),
  reports: (request: SeoOpsPageRequest = {}, signal?: AbortSignal) =>
    requestJson<Page<ReportItem>>(`/api/seo-ops/reports${query(request)}`, { signal }),
  task: (id: string, signal?: AbortSignal) => requestJson<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}`, { signal }),
  events: (id: string, request: SeoOpsPageRequest = {}, signal?: AbortSignal) =>
    requestJson<Page<TaskEvent>>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/events${query(request)}`, { signal }),
  // 阶段运行：归属商户，不建任务。
  stageRuns: (merchantId: string, request: SeoOpsPageRequest = {}, signal?: AbortSignal) =>
    requestJson<Page<StageRunView>>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/stage-runs${query(request)}`, { signal }),
  runsLedger: (request: RunsLedgerRequest = {}, signal?: AbortSignal) =>
    requestJson<RunsLedgerView>(`/api/seo-ops/agent-runs${query(request as SeoOpsPageRequest)}`, { signal }),
  stageRun: (id: string, signal?: AbortSignal) =>
    requestJson<StageRunView>(`/api/seo-ops/agent-runs/${encodeURIComponent(id)}`, { signal }),
  triggerStageRun: (merchantId: string, request: TriggerStageRunRequest) =>
    post<StageRunView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/stage-runs`, request),
  cancelStageRun: (id: string) =>
    post<StageRunView>(`/api/seo-ops/agent-runs/${encodeURIComponent(id)}/cancel`, {}),
  // 兑底：agent 只回正文不回附件时，手工上传交付物解锁阶段。
  uploadManualDeliverable: (runId: string, request: ManualDeliverableRequest) =>
    post<DeliverableWire>(`/api/seo-ops/agent-runs/${encodeURIComponent(runId)}/deliverables`, request),
  createMerchant: (request: unknown) => post<MerchantOnboardingView>("/api/seo-ops/merchants", request),
  lifecycle: (merchantId: string, signal?: AbortSignal) =>
    requestJson<LifecycleView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/lifecycle`, { signal }),
  ranking: (merchantId: string, signal?: AbortSignal) =>
    requestJson<RankingOverviewView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/ranking`, { signal }),
  cycleLedger: (merchantId: string, signal?: AbortSignal) =>
    requestJson<CycleLedgerView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/cycle-ledger`, { signal }),
  postProgram: (merchantId: string, signal?: AbortSignal) =>
    requestJson<PostProgramView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/post-program`, { signal }),
  createQuestionnaire: (merchantId: string, request: { website?: string; idempotency_key: string }) =>
    post<QuestionnaireView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/questionnaires`, request),
  sendQuestionnaire: (questionnaireId: string) =>
    post<QuestionnaireView>(`/api/seo-ops/questionnaires/${encodeURIComponent(questionnaireId)}/send`, {}),
  questionnaireForm: (slug: string, signal?: AbortSignal) =>
    requestJson<{ status: QuestionnaireStatus; merchant_name: string; base_info: Record<string, string>; questions?: QuestionnaireItemWire[] }>(`/api/public/questionnaire-forms/${encodeURIComponent(slug)}`, { signal }),
  submitQuestionnaire: (slug: string, answers: Record<string, string>) =>
    post<{ status: QuestionnaireStatus }>(`/api/public/questionnaire-forms/${encodeURIComponent(slug)}/submissions`, { answers }),
  createLocation: (merchantId: string, request: unknown) =>
    post<LocationView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/locations`, request),
  createTask: (request: CreateTaskRequest) => post<SeoTask>("/api/seo-ops/tasks", request),
  createRevision: (id: string, request: CreateRevisionRequest) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/revisions`, request),
  appendEvidence: (id: string, request: AppendEvidenceRequest) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/evidence`, request),
  linkConversation: (id: string, request: { conversation_id: string; expected_state_version: number; idempotency_key: string }) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/conversation-links`, request),
  approvalPreview: (id: string, request: { task_revision: number; expected_state_version: number }) =>
    post<ApprovalPreview>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/approval-previews`, request),
  approvalDecision: (id: string, request: ApprovalDecisionRequest) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/approval-decisions`, request),

  // ---- 执行域（门 2 / attempts / 查证 / 核验） ----
  inboxSummary: (signal?: AbortSignal) =>
    requestJson<InboxSummaryWire>("/api/seo-ops/inbox-summary", { signal }),
  activity: (request: { hours?: number; limit?: number } = {}, signal?: AbortSignal) =>
    requestJson<ActivityFeedView>(`/api/seo-ops/activity${query(request as SeoOpsPageRequest)}`, { signal }),
  executionPreview: (id: string, signal?: AbortSignal) =>
    requestJson<ExecutionPreviewWire>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/execution-preview`, { signal }),
  confirmExecution: (id: string, request: {
    expected_state_version: number; idempotency_key: string;
    expected_task_revision?: number; expected_execution_spec_hash?: string; scheduled_for?: string;
  }) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/execution-confirmations`, request),
  gbpExecution: (id: string, signal?: AbortSignal) =>
    requestJson<GbpExecutionWire>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/gbp-execution`, { signal }),
  attempts: (id: string, signal?: AbortSignal) =>
    requestJson<{ items: AttemptWire[] }>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/attempts`, { signal }),
  taskArtifacts: (id: string, signal?: AbortSignal) =>
    requestJson<{ items: SpecialistArtifactWire[] }>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/artifacts`, { signal }),
  decideArtifactAcceptance: (artifactId: string, request: {
    decision: "ACCEPTED" | "REJECTED"; note?: string;
  }) => post<SpecialistArtifactWire>(
    `/api/seo-ops/artifacts/${encodeURIComponent(artifactId)}/acceptance`,
    request,
  ),
  taskAuditReferences: (id: string, request: SeoOpsPageRequest = {}, signal?: AbortSignal) =>
    requestJson<TaskAuditReferencesWire>(
      `/api/seo-ops/tasks/${encodeURIComponent(id)}/audit-references${query(request)}`,
      { signal },
    ),
  merchantArtifacts: (merchantId: string, artifactType?: SpecialistArtifactType, signal?: AbortSignal) =>
    requestJson<{ items: SpecialistArtifactWire[] }>(
      `/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/artifacts${artifactType ? `?artifact_type=${encodeURIComponent(artifactType)}` : ""}`,
      { signal },
    ),
  resolveOutcome: (attemptId: string, request: {
    resolution: "HAPPENED" | "NOT_HAPPENED"; note?: string; published_ref?: string;
    expected_state_version: number; idempotency_key: string;
  }) => post<SeoTask>(`/api/seo-ops/attempts/${encodeURIComponent(attemptId)}/outcome`, request),
  verifyTask: (id: string, request: { note?: string; published_ref?: string; expected_state_version: number; idempotency_key: string }) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/verification`, request),
  resetFailedTask: (id: string, request: { note?: string; expected_state_version: number; idempotency_key: string }) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/failed-reset`, request),
  completeManualTask: (id: string, request: { source_ref: string; note?: string; expected_state_version: number; idempotency_key: string }) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/manual-completions`, request),

  // ---- 建议层 ----
  proposalBatches: (merchantId?: string, signal?: AbortSignal) =>
    requestJson<{ items: ProposalBatchWire[] }>(`/api/seo-ops/proposal-batches${merchantId ? `?merchant_id=${encodeURIComponent(merchantId)}` : ""}`, { signal }),
  proposalBatch: (batchId: string, signal?: AbortSignal) =>
    requestJson<ProposalBatchWire>(`/api/seo-ops/proposal-batches/${encodeURIComponent(batchId)}`, { signal }),
  createProposalBatch: (request: unknown) =>
    post<ProposalBatchWire>("/api/seo-ops/proposal-batches", request),
  decideProposal: (proposalId: string, request: {
    action: "ADOPT" | "RETURN"; return_reason?: string; override_priority?: string; override_due_at?: string;
  }) => post<{ proposal: ProposalWire; task_id: string | null }>(`/api/seo-ops/proposals/${encodeURIComponent(proposalId)}/decision`, request),

  // ---- 内容稿 ----
  drafts: (taskId: string, signal?: AbortSignal) =>
    requestJson<{ items: DraftWire[] }>(`/api/seo-ops/tasks/${encodeURIComponent(taskId)}/drafts`, { signal }),
  triggerGbpPostContent: (taskId: string, request: {
    idempotency_key: string;
    retry?: { prior_run_id: string; reason: string; mode?: "RETRY" | "REGENERATE" };
  }) =>
    post<StageRunView>(`/api/seo-ops/tasks/${encodeURIComponent(taskId)}/content-runs`, request),
  addDraft: (taskId: string, request: {
    body: string; cta_type?: string; cta_url?: string; media?: string[];
    source: "AGENT_GENERATED" | "AGENT_REWRITE" | "HUMAN_EDIT"; feedback?: string;
  }) => post<DraftWire>(`/api/seo-ops/tasks/${encodeURIComponent(taskId)}/drafts`, request),
  addDraftRevision: (taskId: string, request: {
    body: string; cta_type?: string; cta_url?: string; media?: string[];
    source: "HUMAN_EDIT"; expected_state_version: number; idempotency_key: string;
  }) => post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(taskId)}/draft-revisions`, request),
  finalizeDraft: (taskId: string, version: number, request: { expected_state_version: number; idempotency_key: string }) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(taskId)}/drafts/${version}/finalize`, request),

  // ---- 设置：能力矩阵 / 周期 / 绑定 ----
  capabilities: (merchantId: string, signal?: AbortSignal) =>
    requestJson<{ items: CapabilityWire[] }>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/capabilities`, { signal }),
  upsertCapability: (merchantId: string, capability: string, request: {
    asset: string; external_ref?: string | null; tech_connected: boolean; merchant_authorized: boolean; note?: string | null;
  }) => requestJson<CapabilityWire>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/capabilities/${encodeURIComponent(capability)}`, { method: "PUT", body: JSON.stringify(request) }),
  cycleConfig: (merchantId: string, signal?: AbortSignal) =>
    requestJson<CycleConfigWire | null>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/cycle-config`, { signal }),
  upsertCycleConfig: (merchantId: string, request: {
    snapshot_day: number | null; post_weekday: number | null; post_per_week: number;
    review_window_days: number; audit_interval_days: number | null; enabled: boolean;
  }) => requestJson<CycleConfigWire>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/cycle-config`, { method: "PUT", body: JSON.stringify(request) }),
  agentBindings: (signal?: AbortSignal) =>
    requestJson<{ items: AgentBindingWire[]; binding_keys: string[] }>("/api/seo-ops/agent-bindings", { signal }),
  upsertAgentBinding: (taskType: string, request: { agent_id: string; agent_label?: string | null; published_ref?: string | null }) =>
    requestJson<AgentBindingWire>(`/api/seo-ops/agent-bindings/${encodeURIComponent(taskType)}`, { method: "PUT", body: JSON.stringify(request) }),
  gbpLocationBinding: (merchantId: string, locationId: string, signal?: AbortSignal) =>
    requestJson<GbpLocationBindingWire>(
      `/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/locations/${encodeURIComponent(locationId)}/gbp-execution-binding`,
      { signal },
    ),
  putGbpLocationBinding: (merchantId: string, locationId: string, request: {
    expected_state_version: number; account_resource: string; location_resource: string;
    timezone: string; core_api_user_id: string; core_api_user_external_id: string;
    write_secret_ref: string; readback_secret_ref: string; write_agent_id: string;
    write_agent_published_ref: string; readback_agent_id: string;
    readback_agent_published_ref: string; status: "DISABLED" | "READY" | "BLOCKED";
  }) => requestJson<GbpLocationBindingWire>(
    `/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/locations/${encodeURIComponent(locationId)}/gbp-execution-binding`,
    { method: "PUT", body: JSON.stringify(request) },
  ),

  runtimeControls: (merchantId: string, signal?: AbortSignal) =>
    requestJson<RuntimeControlsView>(
      `/api/seo-ops/runtime-controls?merchant_id=${encodeURIComponent(merchantId)}`,
      { signal },
    ),
  setRuntimeControl: (request: {
    scope: "GLOBAL" | "MERCHANT"; merchant_id: string | null; paused: boolean; reason: string;
  }) => post<RuntimeControlWire>("/api/seo-ops/runtime-controls", request),

  // ---- 管理入口（冒烟/演示） ----
  schedulerTick: () => post<SchedulerTickResult>("/api/seo-ops/admin/scheduler-tick", {}),
  executionTick: () => post<{ status: string }>("/api/seo-ops/admin/execution-tick", {})
};
