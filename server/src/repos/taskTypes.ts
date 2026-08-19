import type {
  ApprovalAction,
  EvidenceState,
  EvidenceVerification,
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
  /** idempotency_key -> request fingerprint for task sub-mutations. */
  mutationKeys: Record<string, string>;
  creationIdempotencyKey: string | null;
  requestFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
