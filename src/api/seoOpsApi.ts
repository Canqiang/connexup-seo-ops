import { requestJson } from "./client";
import type {
  AgentBindingWire, AppendEvidenceRequest, ApprovalDecisionRequest, ApprovalPreview, AttemptWire,
  CapabilityWire, CreateRevisionRequest, CreateTaskRequest, CycleConfigWire,
  DeliverableWire, DraftWire, ExecutionPreviewWire, InboxSummaryWire, LifecycleView, LocationView,
  ManualDeliverableRequest, MerchantOnboardingView, Page, PortfolioResponse, ProposalBatchWire, ProposalWire,
  QuestionnaireItemWire, QuestionnaireStatus, QuestionnaireView, RankingOverviewView, ReportItem, ReviewItem, RuntimeConfig,
  SchedulerTickResult, SeoOpsPageRequest, SeoTask, SpecialistArtifactType, SpecialistArtifactWire,
  StageRunView, TaskEvent, TaskSummary, TriggerStageRunRequest, WorkbenchRequest, WorkbenchView
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
  executionPreview: (id: string, signal?: AbortSignal) =>
    requestJson<ExecutionPreviewWire>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/execution-preview`, { signal }),
  confirmExecution: (id: string, request: { expected_state_version: number; idempotency_key: string }) =>
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/execution-confirmations`, request),
  attempts: (id: string, signal?: AbortSignal) =>
    requestJson<{ items: AttemptWire[] }>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/attempts`, { signal }),
  taskArtifacts: (id: string, signal?: AbortSignal) =>
    requestJson<{ items: SpecialistArtifactWire[] }>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/artifacts`, { signal }),
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
  addDraft: (taskId: string, request: {
    body: string; cta_type?: string; cta_url?: string; media?: string[];
    source: "AGENT_GENERATED" | "AGENT_REWRITE" | "HUMAN_EDIT"; feedback?: string;
  }) => post<DraftWire>(`/api/seo-ops/tasks/${encodeURIComponent(taskId)}/drafts`, request),
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

  // ---- 管理入口（冒烟/演示） ----
  schedulerTick: () => post<SchedulerTickResult>("/api/seo-ops/admin/scheduler-tick", {}),
  executionTick: () => post<{ status: string }>("/api/seo-ops/admin/execution-tick", {})
};
