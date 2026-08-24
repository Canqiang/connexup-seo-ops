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
/** 可一键触发 agent 运行的阶段（EXECUTE/VERIFY 人工环节，永不可触发）。 */
export type AgentRunStage = "KEYWORDS" | "AUDIT" | "RANKING_BASELINE" | "PLAN" | "REVIEW";
export type DeliverableKind = "SUMMARY" | "ATTACHMENT" | "MANUAL";

export type QuestionnaireStatus = "DRAFT" | "SENT" | "FILLED";
export interface QuestionnaireItemWire { id: string; question: string; hint?: string; required: boolean }
export interface QuestionnaireView {
  id: string; merchant_id: string; status: QuestionnaireStatus; share_slug: string;
  base_info: Record<string, string>; questions: QuestionnaireItemWire[];
  answers: Record<string, string> | null; send_count: number;
  sent_at: string | null; last_sent_at: string | null; filled_at: string | null;
  created_at: string; updated_at: string;
}

export type LifecycleStageKey = "QUESTIONNAIRE" | "KEYWORDS" | "AUDIT" | "RANKING_BASELINE" | "PLAN" | "EXECUTE" | "VERIFY";
export type StageStatus = "DONE" | "CURRENT" | "OFF";
export interface LifecycleStageWire { key: LifecycleStageKey; status: StageStatus; note: string }
export type MerchantExceptionType = "WAITING_MERCHANT" | "PLAN_PENDING" | "APPROVAL" | "VERIFY" | "RANKING_DUE" | "NONE";
export interface MerchantExceptionWire {
  type: MerchantExceptionType; waiting_days?: number; send_count?: number;
  questionnaire_id?: string; count?: number; age_days?: number; since?: string;
}
/** 各阶段最近一次「算数」的运行（COMPLETED 且有落盘附件）。 */
export interface LatestRunWire {
  run_id: string; stage: AgentRunStage; run_type: string; completed_at: string;
  output_preview: string | null; deliverable_count: number;
}
export interface LifecycleView {
  merchant_id: string; stage: LifecycleStageKey; stages: LifecycleStageWire[];
  questionnaire: {
    id: string; status: QuestionnaireStatus; share_slug: string; send_count: number;
    sent_at: string | null; last_sent_at: string | null; filled_at: string | null;
  } | null;
  latest_runs: Partial<Record<AgentRunStage, LatestRunWire>>;
  plan_converted: boolean;
  open_task_count: number; approved_task_count: number; ready_for_approval_count: number;
  unverified_evidence_count: number;
  last_report: { captured_at: string; age_days: number } | null;
  /** 轮次 = 有附件的排名运行次数（首轮基线 + 每次复查各算一轮）。 */
  ranking_round_count: number;
  exception: MerchantExceptionWire;
}

/** 排名快照行：位次 null = 无排名（出包/未收录）；delta 正数 = 较上期上升。 */
export interface RankingRowWire {
  keyword: string; local_rank: number | null; organic_rank: number | null;
  local_delta: number | null; organic_delta: number | null; is_new: boolean;
}
export interface RankingOverviewView {
  round_count: number;
  latest: { run_id: string; captured_at: string; keyword_count: number; rows: RankingRowWire[] } | null;
  previous: { run_id: string; captured_at: string } | null;
  comparison: {
    local_avg: { current: number | null; previous: number | null; delta: number | null };
    organic_top10: { current: number; previous: number; total: number };
    new_keyword_count: number;
  } | null;
}

/** 交付物：附件是主交付物；download_path 是本地服务路由（不暴露远端 URL）。 */
export interface DeliverableWire {
  id: string; kind: DeliverableKind; file_name: string; content_type: string | null;
  size: number | null; title: string | null; description: string | null;
  sha256: string | null; downloaded: boolean; download_error?: string;
  download_path: string; created_at: string;
}
/** 阶段运行：归属于（商户，地点，阶段），不挂在 task 上。 */
export interface StageRunView {
  id: string; merchant_id: string; location_id: string | null;
  stage: AgentRunStage; run_type: string; goal: string | null; status: AgentRunStatus;
  core_run_id?: string; core_status?: string; input_message: string;
  output?: string | null; output_preview?: string | null;
  error?: string; error_code?: string; token_usage: Record<string, number>;
  deliverables: DeliverableWire[];
  triggered_by: string; triggered_at: string; last_polled_at?: string; completed_at?: string;
  created_at: string; updated_at: string;
}
export interface TriggerStageRunRequest {
  stage: AgentRunStage; location_id?: string; goal?: string; idempotency_key: string;
}
export interface ManualDeliverableRequest {
  file_name: string; content_type?: string; content_base64: string;
}

export interface RuntimeConfig {
  copilot_enabled: boolean; copilot_agent_id?: string;
  agent_run_enabled?: boolean; agent_run_stages?: AgentRunStage[];
}
export interface AuthenticatedUser { user_id: string; name: string; role: string; permissions: string[] }
export interface LocationSummary { id: string; display_name: string; readiness_status: LocationReadiness }
export interface MerchantSummary {
  id: string; slug: string; display_name: string; operator_user_ids: string[]; operators: IdName[];
  owner_ids: string[]; locations: LocationSummary[]; location_count: number; task_count: number;
  ready_for_approval_count: number; blocked_count: number; overdue_count: number;
  health: "STABLE" | "ATTENTION" | "BLOCKED";
  /** 生命周期当前阶段与首页异常分组（后端推导；旧存根可缺省）。 */
  stage?: LifecycleStageKey;
  exception?: MerchantExceptionWire;
}
export interface PortfolioResponse {
  merchants: MerchantSummary[];
  totals: { tasks: number; blocked: number; ready_for_approval: number; overdue: number };
}
export interface SeoOpsPageRequest {
  offset?: number; limit?: number; merchant_id?: string; location_id?: string; status?: string;
  owner_id?: string; evidence_state?: EvidenceState; report_type?: string; captured_from?: string;
  captured_to?: string; freshness?: string; stage?: string;
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
  report_id: string; source_type: "TASK_EVIDENCE" | "CORE_AI_ARTIFACT";
  merchant_id: string; merchant_name: string; location_id?: string; location_name?: string;
  task_id?: string; evidence_id?: string; agent_run_id?: string; core_run_id?: string;
  report_type: string; artifact_id?: string; file_id?: string; file_name?: string; title?: string;
  content_type?: string; size?: number; source_ref?: string; download_path?: string;
  sha256?: string; captured_at: string; freshness: ReportFreshness;
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
