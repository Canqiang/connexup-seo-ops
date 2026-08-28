export type SeoTaskStatus =
  | "DRAFT" | "NEEDS_INPUT" | "BLOCKED" | "READY_FOR_APPROVAL"
  | "APPROVED" | "REVISION_REQUIRED" | "APPROVAL_REVOKED"
  | "EXECUTION_CONFIRMED" | "DISPATCHING" | "OUTCOME_UNKNOWN"
  | "PENDING_VERIFY" | "VERIFIED" | "DONE" | "FAILED";
/** Ⓐ READ_ONLY 自动跑；Ⓑ ARTIFACT 成品需批；Ⓒ AUTO_WRITE 双门；MANUAL 人工。 */
export type ExecutionMode = "AUTO_WRITE" | "ARTIFACT" | "READ_ONLY" | "MANUAL";
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
  sent_at: string | null; last_sent_at: string | null; last_sent_by: string | null; filled_at: string | null;
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

/** 交付物：附件是主交付物；download_path 是本地服务路由（证据主通道）。
 * core_url 是 core-ai 原始附件直链（本地 demo 跳转用，可能不可达）。 */
export interface DeliverableWire {
  id: string; kind: DeliverableKind; file_name: string; content_type: string | null;
  size: number | null; title: string | null; description: string | null;
  sha256: string | null; downloaded: boolean; download_error?: string;
  download_path: string; core_url?: string | null; created_at: string;
}
/** 阶段运行：归属于（商户，地点，阶段），不挂在 task 上。 */
export interface StageRunView {
  id: string; merchant_id: string; location_id: string | null;
  task_id?: string | null; stage: AgentRunStage | "GBP_POST_CONTENT"; run_type: string; goal: string | null; status: AgentRunStatus;
  core_run_id?: string; core_status?: string; input_message: string;
  output?: string | null; output_preview?: string | null;
  error?: string; error_code?: string; token_usage: Record<string, number>;
  request_fingerprint?: string; http_request_fingerprint?: string;
  business_input_fingerprint?: string; retry_of_agent_run_id?: string;
  retry_generation?: number; retry_reason?: string;
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
  core_ai_console_url?: string | null;
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
export type HumanActionGroup = "GATEKEEPING" | "EXCEPTION" | "MERCHANT_CONTACT";
export type HumanActionType = "PROPOSAL_DECISION" | "GATE_1_APPROVAL" | "GATE_2_CONFIRM"
  | "OUTCOME_RECONCILIATION" | "VERIFICATION_OVERDUE" | "CONFIRMED_FAILURE"
  | "QUESTIONNAIRE_FOLLOWUP" | "AUTHORIZATION_FOLLOWUP" | "CONTENT_CONFIRMATION"
  | "REPORT_DELIVERY" | "ARTIFACT_ACCEPTANCE";
export interface WorkbenchRequest {
  group?: HumanActionGroup; merchant_id?: string; q?: string; offset?: number; limit?: number;
}
export interface HumanActionWire {
  id: string; group: HumanActionGroup; type: HumanActionType;
  merchant_id: string; merchant_name: string; location_name: string | null;
  title: string; reason: string;
  primary_action: { label: string; href: string }; secondary_href: string | null;
  priority: TaskPriority; due_at: string | null; waiting_since: string;
}
export interface WorkbenchView {
  summary: { gatekeeping: number; exception: number; merchant_contact: number; total: number };
  items: HumanActionWire[]; offset: number; limit: number; total: number;
}
export interface TaskDefinitionInput {
  title: string; task_type: string; source: string; priority: TaskPriority; impact: TaskImpact;
  owner_id?: string; due_at?: string; execution_spec: string; required_evidence_types: string[];
  execution_mode?: ExecutionMode;
  conversation_id?: string;
}
export interface CreateTaskRequest { merchant_id: string; location_id?: string; definition: TaskDefinitionInput; idempotency_key: string }
export interface CreateRevisionRequest { definition: TaskDefinitionInput; expected_state_version: number; idempotency_key: string }
export interface TaskSummary {
  id: string; merchant_id: string; merchant_name: string; location_id?: string; location_name?: string;
  title: string; task_type: string; priority: TaskPriority; impact: TaskImpact; owner_id?: string;
  due_at?: string; status: SeoTaskStatus; evidence_state: EvidenceState; task_revision: number;
  state_version: number; updated_at: string;
  source?: string; execution_mode?: ExecutionMode; attempt_count?: number;
}
export interface Page<T> { items: T[]; offset: number; limit: number; total: number }
export interface EvidenceRef {
  id: string; task_revision: number; type: string; artifact_id?: string; file_id?: string;
  source_ref?: string; sha256?: string; captured_at: string; verification_status: EvidenceVerification;
  requirement_key: string; created_by: string; created_at: string;
  reused_from_evidence_id?: string;
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
  execution_mode: ExecutionMode; proposal_id: string | null; attempt_count: number;
  depends_on_task_ids: string[];
  published_ref: string | null; published_at: string | null; verify_due_at: string | null;
  verified_at: string | null; verified_by: string | null;
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
export interface EffectReviewItem { artifact_id: string; merchant_id: string; merchant_name: string; task_id: string; core_run_id: string; title: string; summary: string; conclusion_tier: string; conclusion: string; baseline: Record<string, unknown>; observed_change: Record<string, unknown>; action_bundle: Array<Record<string, unknown>>; confounders: string[]; limitations: string[]; planning_signals: Array<Record<string, unknown>>; acceptance_status: string; created_at: string; causal_identified: false }
export interface ReviewWindow { merchant_id: string; merchant_name: string; review_window_days: number | null; last_review_at: string | null; next_window_at: string | null; status: "DUE" | "UPCOMING" | "UNSCHEDULED" }
export interface EffectReviewsView { summary: { total: number; by_tier: Record<string, number>; due_count: number }; items: EffectReviewItem[]; windows: ReviewWindow[] }
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
export interface MerchantOnboardingView extends MerchantView {
  planner_enqueued: boolean;
  planner_task_id: string | null;
}
export interface LocationView extends LocationSummary {
  merchant_id: string; slug: string; timezone: string; external_identities: Record<string, string>;
  missing_requirements: string[]; created_at: string; updated_at: string;
}

// ---------------- 执行域 / 建议层 / 设置（v2 账本视角） ----------------

export type ProposalStatus = "PENDING" | "VALIDATION_FAILED" | "ADOPTED" | "RETURNED";
export type ProposalOrigin = "PLANNER" | "PLAN_CONVERT" | "MANUAL";
export type AttemptStatus = "DISPATCHING" | "SUCCEEDED" | "FAILED_CONFIRMED" | "OUTCOME_UNKNOWN";
export type CapabilityStatus = "ACTIVE" | "BLOCKED" | "MISSING";

export interface ProposalWire {
  id: string; batch_id: string; merchant_id: string; location_id: string | null;
  seq: number; title: string; task_type: string; execution_mode: ExecutionMode;
  executor_agent: string | null; depends_on: number[]; due_at: string | null;
  priority: TaskPriority; impact: TaskImpact; acceptance_criteria: string | null;
  execution_spec: string; required_evidence_types: string[];
  validation_failures: string[]; status: ProposalStatus;
  decided_by: string | null; decided_at: string | null; return_reason: string | null;
  task_id: string | null; created_at: string; updated_at: string;
}

export interface ProposalBatchWire {
  id: string; merchant_id: string; merchant_name?: string; origin: ProposalOrigin;
  trigger_reason: string | null; planner_run_id: string | null; snapshot_note: string | null;
  status: "OPEN" | "CLOSED"; created_by: string | null; created_at: string; updated_at: string;
  proposals: ProposalWire[];
}

export interface AttemptWire {
  id: string; task_id: string; merchant_id: string; attempt_no: number;
  status: AttemptStatus; gate: "G2" | "AUTO"; agent_run_id: string | null;
  core_run_id: string | null; probe_ref: string; error: string | null;
  gbp_command_id?: string | null;
  started_at: string; resolved_at: string | null; resolved_by: string | null;
  resolution: "HAPPENED" | "NOT_HAPPENED" | null; resolution_note: string | null;
}

export interface GateCheckWire { key: string; label: string; passed: boolean; detail: string }
export interface ExecutionPreviewWire {
  confirmable: boolean; checks: GateCheckWire[]; attempt_count: number; gate_ready_status: boolean;
}

export interface CapabilityWire {
  id: string; merchant_id: string; asset: string; capability: string;
  external_ref: string | null; tech_connected: boolean; merchant_authorized: boolean;
  status: CapabilityStatus; verified_at: string | null; verified_by: string | null;
  note: string | null; updated_at: string;
}

export interface CycleConfigWire {
  merchant_id: string; snapshot_day: number | null; post_weekday: number | null;
  post_per_week: number; review_window_days: number; audit_interval_days: number | null;
  enabled: boolean; updated_by: string | null; updated_at: string;
}

/** 风格档案：voice 编辑生成新版本，稿件按引用固定版本；档案更新不追溯已批准稿。 */
export interface StyleProfileWire {
  id: string; merchant_id: string; version: number; voice: Record<string, unknown>;
  updated_by: string | null; created_at: string;
}

/** Merchant control-room projections retain the Task/proposal boundary all
 * the way to the client.  A proposal row is never executable work. */
export interface CycleLedgerItem {
  record_kind: "TASK" | "PROPOSAL";
  task_id: string | null; proposal_id: string | null;
  title: string; task_type: string; priority: TaskPriority | null; owner_id: string | null;
  due_at: string | null; created_at: string; status: string; execution_mode: ExecutionMode;
  dependency_labels: string[]; validation_failures: string[];
}

export interface CycleLedgerView { items: CycleLedgerItem[]; }

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
    artifact_id: string; task_id: string; cluster: string;
    signal: "IMPROVED" | "FLAT" | "DECLINED" | "INCONCLUSIVE";
    observed_at: string; evidence_ref: string | null;
  }>;
  history: Array<{
    task_id: string; title: string; published_ref: string; published_at: string;
    verified_at: string; verified_by: string | null;
  }>;
  proposals: Array<{
    proposal_id: string; title: string; due_at: string | null; priority: TaskPriority;
    status: "PENDING" | "VALIDATION_FAILED"; validation_failures: string[];
  }>;
  evidence_gaps: string[];
}

export interface AgentBindingWire {
  task_type: string; agent_id: string; agent_label: string | null;
  published_ref: string | null; updated_by: string | null; updated_at: string;
}

export type GbpBindingStatus = "MISSING" | "DISABLED" | "READY" | "BLOCKED";
export interface GbpLocationBindingWire {
  merchant_id: string; location_id: string;
  account_resource: string | null; location_resource: string | null; timezone: string | null;
  core_api_user_id: string | null; core_api_user_external_id: string | null;
  write_secret_ref: string | null; readback_secret_ref: string | null;
  write_agent_id: string | null; write_agent_published_ref: string | null;
  readback_agent_id: string | null; readback_agent_published_ref: string | null;
  status: GbpBindingStatus; state_version: number; ready_for_gate2: boolean;
  missing_fields: string[]; updated_by: string | null; updated_at: string | null;
}

export interface GbpExecutionWire {
  task_id: string;
  available: boolean;
  store?: {
    merchant_name: string; location_name: string;
    account_resource?: string | null; location_resource?: string | null; timezone: string | null;
  };
  schedule?: { utc: string; local: string };
  approved?: {
    body: string;
    cta: { type: string; url: string | null };
    image: { deliverable_id: string; sha256: string; alt_text: string; download_path: string };
  };
  hashes?: { command?: string; execution_spec: string; draft: string; body?: string; cta?: string; image: string };
  task_revision?: number;
  draft_version?: number;
  binding?: { ready_for_gate2: boolean; missing_fields: string[]; state_version: number };
  command_state?: {
    status: string; state_version: number; scheduled_for: string; safe_error_code: string | null;
    trigger_started_at: string | null; updated_at: string;
  } | null;
  receipt?: { status: string; provider_mutation_count: number; created_at: string } | null;
  readbacks?: Array<{ id: string; diff_codes: string[]; safe_error_code: string | null; created_at: string }>;
}

export interface DraftWire {
  id: string; task_id: string; agent_run_id?: string | null; media_source_agent_run_id?: string | null; version: number; body: string;
  cta_type: string | null; cta_url: string | null; media: string[];
  media_previews?: Array<{
    deliverable_id: string; sha256: string; download_path: string; alt_text: string;
    origin?: "AI_GENERATED" | "OPERATOR_UPLOAD";
  }>;
  source: "AGENT_GENERATED" | "AGENT_REWRITE" | "HUMAN_EDIT";
  feedback: string | null; sha256: string; created_by: string | null; created_at: string;
}

export type SpecialistArtifactType =
  | "KEYWORD_SET"
  | "KEYWORD_WEEKLY"
  | "AUDIT_REPORT"
  | "RANKING_SNAPSHOT"
  | "EXECUTION_PLAN"
  | "EFFECT_REVIEW"
  | "MERCHANT_REPORT";
export interface SpecialistArtifactWire {
  id: string; task_id: string; merchant_id: string; artifact_type: SpecialistArtifactType;
  schema_version: string; title: string; summary: string; payload: Record<string, unknown>;
  core_run_id: string; created_by: string | null; created_at: string;
  acceptance_status?: "PENDING" | "ACCEPTED" | "REJECTED";
  acceptance_decided_by?: string | null; acceptance_decided_at?: string | null;
  acceptance_note?: string | null;
}
export interface TaskAuditReferencesWire {
  offset?: number; limit?: number; total?: number;
  agent_runs: Array<{
    id: string; core_run_id?: string; trace_ref?: string;
    request_fingerprint?: string; http_request_fingerprint?: string;
    business_input_fingerprint?: string; retry_of_agent_run_id?: string;
    retry_generation?: number; retry_reason?: string;
    deliverables: Array<{ id: string; file_id?: string; sha256?: string; source_ref?: string }>;
  }>;
  artifacts: Array<{ id: string; core_run_id: string }>;
  execution_attempts?: Array<{ id: string; agent_run_id?: string; core_run_id?: string; trace_ref?: string; probe_ref: string; deliverables: Array<{ id: string; file_id: string; sha256?: string; source_ref?: string }> }>;
}

export interface InboxSummaryWire {
  pending_proposals: number; ready_for_approval: number; awaiting_execution: number;
  pending_verify: number; outcome_unknown: number; verification_overdue: number;
  frozen_merchant_ids: string[];
}

export type ActivitySeverity = "INFO" | "WARN" | "DANGER";
export interface ActivityItem {
  id: string; kind: "TASK_EVENT" | "AGENT_RUN" | "PROPOSAL_BATCH"; occurred_at: string;
  merchant_id: string; merchant_name: string; title: string; detail: string | null; href: string; severity: ActivitySeverity;
}
export interface ActivityFeedView { items: ActivityItem[]; since: string }

export interface SchedulerTickResult {
  created: Array<{ task_id: string; key: string; task_type: string; merchant_id: string }>;
  dispatched: number;
}

export interface RuntimeControlWire {
  id: string;
  scope: "GLOBAL" | "MERCHANT";
  merchant_id: string | null;
  paused: boolean;
  reason: string;
  changed_by: string;
  created_at: string;
}

export interface RuntimeControlsView {
  global: RuntimeControlWire | null;
  merchant: RuntimeControlWire | null;
  effective_paused: boolean;
  effective_source: "GLOBAL" | "MERCHANT" | null;
  effective_reason: string | null;
}

export interface RunLedgerRow {
  id: string; merchant_id: string; merchant_name: string; location_id: string | null;
  task_id: string | null; stage: string; run_type: string; status: AgentRunStatus;
  core_run_id: string | null; trace_ref: string | null; error_code: string | null;
  triggered_by: string; triggered_at: string; completed_at: string | null;
  duration_ms: number | null; token_total: number; deliverable_count: number;
}
export interface RunsLedgerView {
  summary: {
    in_flight: number; queued: number; completed_today: number; failed_today: number;
    content_runs_today: number; token_total_today: number;
    outcome_unknown: number; frozen_merchant_ids: string[]; day_start: string;
  };
  items: RunLedgerRow[]; offset: number; limit: number; total: number;
}
export interface RunsLedgerRequest {
  merchant_id?: string; status?: AgentRunStatus; stage?: string; include_content?: "true" | "false";
  offset?: number; limit?: number;
}
