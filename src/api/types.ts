export type SeoTaskStatus =
  | "DRAFT" | "NEEDS_INPUT" | "BLOCKED" | "READY_FOR_APPROVAL"
  | "APPROVED" | "REVISION_REQUIRED" | "APPROVAL_REVOKED";
export type EvidenceState = "NONE" | "PARTIAL" | "VERIFIED" | "UNVERIFIABLE";
export type ApprovalAction = "APPROVE" | "REJECT" | "REVOKE";
export type TaskPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";
export type TaskImpact = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type EvidenceVerification = "UNVERIFIED" | "VERIFIED" | "UNVERIFIABLE";
export type ReviewClassification = "FACTUAL" | "CORRELATIONAL" | "CAUSAL_READY" | "INSUFFICIENT_EVIDENCE";
export type ReportFreshness = "FRESH" | "AGING" | "STALE";
export type LocationReadiness = "READY" | "BLOCKED" | "INCOMPLETE";
export interface IdName { id: string; name: string }

export type AgentRunType = "AUDIT" | "KEYWORD_RESEARCH" | "PLAN" | "REPORT" | "REVIEW";
export type AgentRunStatus = "TRIGGERING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export interface AgentRunView {
  id: string; task_id: string; run_type: string; goal: string | null; status: AgentRunStatus;
  core_run_id?: string; core_status?: string; input_message: string;
  output?: string | null; output_preview?: string | null;
  error?: string; error_code?: string; token_usage: Record<string, number>;
  artifact_path?: string; artifact_sha256?: string; evidence_id?: string; evidence_skipped_reason?: string;
  triggered_by: string; triggered_at: string; last_polled_at?: string; completed_at?: string;
  created_at: string; updated_at: string;
}
export interface TriggerAgentRunRequest { run_type: AgentRunType; goal?: string; idempotency_key: string }

export interface RuntimeConfig {
  copilot_enabled: boolean; copilot_agent_id?: string;
  agent_run_enabled?: boolean; agent_run_types?: string[];
}
export interface AuthenticatedUser { user_id: string; name: string; role: string; permissions: string[] }
export interface LocationSummary { id: string; display_name: string; readiness_status: LocationReadiness }
export interface MerchantSummary {
  id: string; slug: string; display_name: string; operator_user_ids: string[]; operators: IdName[];
  owner_ids: string[]; locations: LocationSummary[]; location_count: number; task_count: number;
  ready_for_approval_count: number; blocked_count: number; overdue_count: number;
  health: "STABLE" | "ATTENTION" | "BLOCKED";
}
export interface PortfolioResponse {
  merchants: MerchantSummary[];
  totals: { tasks: number; blocked: number; ready_for_approval: number; overdue: number };
}
export interface SeoOpsPageRequest {
  offset?: number; limit?: number; merchant_id?: string; location_id?: string; status?: string;
  owner_id?: string; evidence_state?: EvidenceState; report_type?: string; captured_from?: string;
  captured_to?: string; freshness?: string;
}
export interface TaskDefinitionInput {
  title: string; task_type: string; source: string; priority: TaskPriority; impact: TaskImpact;
  owner_id?: string; due_at?: string; execution_spec: string; required_evidence_types: string[];
  conversation_id?: string;
}
export interface CreateTaskRequest { merchant_id: string; location_id?: string; definition: TaskDefinitionInput; idempotency_key: string }
export interface CreateRevisionRequest { definition: TaskDefinitionInput; expected_state_version: number; idempotency_key: string }
export interface TaskSummary {
  id: string; merchant_id: string; merchant_name: string; location_id?: string; location_name?: string;
  title: string; task_type: string; priority: TaskPriority; impact: TaskImpact; owner_id?: string;
  due_at?: string; status: SeoTaskStatus; evidence_state: EvidenceState; task_revision: number;
  state_version: number; updated_at: string;
}
export interface Page<T> { items: T[]; offset: number; limit: number; total: number }
export interface EvidenceRef {
  id: string; task_revision: number; type: string; artifact_id?: string; file_id?: string;
  source_ref?: string; sha256?: string; captured_at: string; verification_status: EvidenceVerification;
  requirement_key: string; created_by: string; created_at: string;
}
export interface ApprovalDecision {
  id: string; decision: ApprovalAction; reason?: string; task_revision: number; execution_spec_hash: string;
  expected_state_version: number; resulting_state_version: number; actor_id: string; decided_at: string;
}
export interface ConversationLink { conversation_id: string; relationship: "ORIGINATING_DRAFT" | "TASK_CHAT"; linked_by: string; linked_at: string }
export interface AgentRunLink { agent_run_id: string; relationship: string; status?: string; linked_by: string; linked_at: string }
export interface TaskEvent {
  id: string; type: string; actor_id: string; from_status?: SeoTaskStatus; to_status?: SeoTaskStatus;
  task_revision: number; resulting_state_version: number; reference_id?: string; occurred_at: string;
}
export interface SeoTask extends TaskSummary {
  source: string; execution_spec: string; execution_spec_hash: string; required_evidence_types: string[];
  evidence_refs: EvidenceRef[]; approval_decisions: ApprovalDecision[]; conversation_links: ConversationLink[];
  agent_run_links: AgentRunLink[]; created_at: string;
}
export interface ApprovalPreview {
  reviewable: boolean; blockers: string[]; task_revision: number; state_version: number;
  execution_spec_hash: string; evidence_state: EvidenceState; current_status: SeoTaskStatus;
}
export interface ReviewItem {
  task_id: string; merchant_id: string; location_id?: string; classification: ReviewClassification;
  goal?: string; baseline?: string; action?: string; observed_change?: string; competing_explanations: string[];
  conclusion_strength: string; follow_up_test?: string; evidence_ids: string[]; updated_at: string;
}
export interface ReportItem {
  task_id: string; merchant_id: string; location_id?: string; evidence_id: string; report_type: string;
  artifact_id?: string; file_id?: string; source_ref?: string; sha256?: string; captured_at: string;
  freshness: ReportFreshness;
}
export interface AppendEvidenceRequest {
  type: string; artifact_id?: string; file_id?: string; source_ref?: string; sha256?: string;
  captured_at: string; verification_status: EvidenceVerification; requirement_key: string;
  expected_state_version: number; idempotency_key: string;
}
export interface ApprovalDecisionRequest {
  decision: ApprovalAction; reason?: string; task_revision: number; execution_spec_hash: string;
  expected_state_version: number; idempotency_key: string;
}
export interface MerchantView {
  id: string; slug: string; display_name: string; tags: string[]; operator_user_ids: string[];
  created_at: string; updated_at: string;
}
export interface LocationView extends LocationSummary {
  merchant_id: string; slug: string; timezone: string; external_identities: Record<string, string>;
  missing_requirements: string[]; created_at: string; updated_at: string;
}
