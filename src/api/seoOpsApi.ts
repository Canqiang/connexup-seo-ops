import { requestJson } from "./client";
import type {
  AgentRunView, AppendEvidenceRequest, ApprovalDecisionRequest, ApprovalPreview, CreateRevisionRequest, CreateTaskRequest,
  LocationView, MerchantView, Page, PortfolioResponse, ReportItem, ReviewItem, RuntimeConfig, SeoOpsPageRequest,
  SeoTask, TaskEvent, TaskSummary, TriggerAgentRunRequest
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
  agentRuns: (taskId: string, request: SeoOpsPageRequest = {}, signal?: AbortSignal) =>
    requestJson<Page<AgentRunView>>(`/api/seo-ops/tasks/${encodeURIComponent(taskId)}/agent-runs${query(request)}`, { signal }),
  agentRun: (id: string, signal?: AbortSignal) =>
    requestJson<AgentRunView>(`/api/seo-ops/agent-runs/${encodeURIComponent(id)}`, { signal }),
  triggerAgentRun: (taskId: string, request: TriggerAgentRunRequest) =>
    post<AgentRunView>(`/api/seo-ops/tasks/${encodeURIComponent(taskId)}/agent-runs`, request),
  cancelAgentRun: (id: string) =>
    post<AgentRunView>(`/api/seo-ops/agent-runs/${encodeURIComponent(id)}/cancel`, {}),
  createMerchant: (request: unknown) => post<MerchantView>("/api/seo-ops/merchants", request),
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
