import { requestJson } from "./client";
import type {
  AppendEvidenceRequest, ApprovalDecisionRequest, ApprovalPreview, CreateRevisionRequest, CreateTaskRequest,
  DeliverableWire, LifecycleView, LocationView, ManualDeliverableRequest, MerchantView, Page, PortfolioResponse,
  QuestionnaireItemWire, QuestionnaireStatus, QuestionnaireView, RankingOverviewView, ReportItem, ReviewItem, RuntimeConfig,
  SeoOpsPageRequest, SeoTask, StageRunView, TaskEvent, TaskSummary, TriggerStageRunRequest
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
  createMerchant: (request: unknown) => post<MerchantView>("/api/seo-ops/merchants", request),
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
    post<SeoTask>(`/api/seo-ops/tasks/${encodeURIComponent(id)}/approval-decisions`, request)
};
