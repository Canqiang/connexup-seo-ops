import type {
  ApprovalAction,
  EvidenceState,
  EvidenceVerification,
  ExecutionMode,
  SeoTaskStatus,
  TaskImpact,
  TaskPriority,
} from "../domain/enums.js";

/** Task aggregate (one row = one optimistic-lock unit). The append-only
 * record arrays live as JSON columns; mutation_keys maps idempotency key ->
 * request fingerprint for sub-mutation replay detection. */
export interface TaskDefinitionRecord {
  revision: number;
  title: string;
  taskType: string;
  source: string;
  priority: TaskPriority;
  impact: TaskImpact;
  ownerId: string | null;
  dueAt: string | null;
  executionSpec: string;
  executionSpecHash: string;
  requiredEvidenceTypes: string[];
  executionMode: ExecutionMode;
  createdBy: string;
  createdAt: string;
}

export interface EvidenceRefRecord {
  id: string;
  taskRevision: number;
  type: string;
  artifactId?: string;
  fileId?: string;
  sourceRef?: string;
  sha256?: string;
  capturedAt: string;
  verificationStatus: EvidenceVerification;
  requirementKey: string;
  createdBy: string;
  createdAt: string;
}

export interface ApprovalDecisionRecord {
  id: string;
  decision: ApprovalAction;
  reason?: string;
  taskRevision: number;
  executionSpecHash: string;
  expectedStateVersion: number;
  resultingStateVersion: number;
  actorId: string;
  decidedAt: string;
}

export interface ConversationLinkRecord {
  conversationId: string;
  relationship: "ORIGINATING_DRAFT" | "TASK_CHAT";
  linkedBy: string;
  linkedAt: string;
}

export interface AgentRunLinkRecord {
  agentRunId: string;
  relationship: string;
  status?: string;
  linkedBy: string;
  linkedAt: string;
}

export interface TaskEventRecord {
  id: string;
  type: string;
  actorId: string;
  fromStatus?: SeoTaskStatus;
  toStatus?: SeoTaskStatus;
  taskRevision: number;
  resultingStateVersion: number;
  referenceId?: string;
  occurredAt: string;
}

export interface Task {
  id: string;
  merchantId: string;
  locationId: string | null;
  taskType: string;
  source: string;
  priority: TaskPriority;
  impact: TaskImpact;
  ownerId: string | null;
  dueAt: string | null;
  status: SeoTaskStatus;
  evidenceState: EvidenceState;
  taskRevision: number;
  stateVersion: number;
  title: string;
  executionSpec: string;
  executionSpecHash: string;
  requiredEvidenceTypes: string[];
  revisions: TaskDefinitionRecord[];
  evidenceRefs: EvidenceRefRecord[];
  approvalDecisions: ApprovalDecisionRecord[];
  events: TaskEventRecord[];
  conversationLinks: ConversationLinkRecord[];
  agentRunLinks: AgentRunLinkRecord[];
  executionMode: ExecutionMode;
  /** 采纳来源建议（只存 ID）。 */
  proposalId: string | null;
  /** 必须先完成的上游 Task。只允许指向同商户、创建时间更早的 Task。 */
  dependsOnTaskIds: string[];
  /** 已派发 attempt 数（含在途）。 */
  attemptCount: number;
  /** provider 侧发布引用（如 GBP postId），查证/成功后回填。 */
  publishedRef: string | null;
  publishedAt: string | null;
  /** 核验期限（发布后 +N 天）。 */
  verifyDueAt: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  /** idempotency_key -> request fingerprint for task sub-mutations. */
  mutationKeys: Record<string, string>;
  creationIdempotencyKey: string | null;
  requestFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
