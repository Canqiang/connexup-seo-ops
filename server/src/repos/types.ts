import type {
  LocationReadiness,
} from "../domain/enums.js";
import type {
  GbpExecutionCommandV1,
  GbpExecutionReceiptV1,
  GbpReadbackV1,
} from "../domain/gbpExecutionContract.js";

/** Domain objects handed between repos and services (camelCase internally;
 * views/mappers.ts converts to the snake_case wire shapes). */
export interface Merchant {
  id: string;
  slug: string;
  displayName: string;
  tags: string[];
  operatorUserIds: string[];
  creationIdempotencyKey: string | null;
  requestFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Location {
  id: string;
  merchantId: string;
  slug: string;
  displayName: string;
  timezone: string | null;
  externalIdentities: Record<string, string>;
  readinessStatus: LocationReadiness;
  missingRequirements: string[];
  creationIdempotencyKey: string | null;
  requestFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GbpLocationBindingStatus = "DISABLED" | "READY" | "BLOCKED";

/** Merchant/location-specific Core and provider coordinates. Secret values are
 * never represented here: only basename-like mounted secret references. */
export interface GbpLocationBinding {
  id: string;
  merchantId: string;
  locationId: string;
  accountResource: string;
  locationResource: string;
  timezone: string;
  coreApiUserId: string;
  coreApiUserExternalId: string;
  writeSecretRef: string;
  readbackSecretRef: string;
  writeAgentId: string;
  writeAgentPublishedRef: string;
  readbackAgentId: string;
  readbackAgentPublishedRef: string;
  status: GbpLocationBindingStatus;
  stateVersion: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GbpCommandRecord {
  id: string;
  bindingId: string;
  bindingStateVersion: number;
  command: GbpExecutionCommandV1;
  commandSha256: string;
  createdBy: string;
  createdAt: string;
}

export type GbpCommandStateStatus =
  | "SCHEDULED"
  | "CLAIMED"
  | "TRIGGERING"
  | "RUNNING"
  | "RECEIPT_ACCEPTED"
  | "READBACK_PENDING"
  | "READBACK_RUNNING"
  | "DONE"
  | "BLOCKED_PRE_SEND"
  | "OUTCOME_UNKNOWN";

export interface GbpCommandState {
  commandId: string;
  merchantId: string;
  locationId: string;
  status: GbpCommandStateStatus;
  scheduledFor: string;
  leaseOwner: string | null;
  leaseAcquiredAt: string | null;
  leaseExpiresAt: string | null;
  triggerStartedAt: string | null;
  coreRunId: string | null;
  safeErrorCode: string | null;
  safeErrorMessage: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GbpCommandClaim {
  command: GbpCommandRecord;
  state: GbpCommandState;
}

export interface GbpReceiptRecord {
  commandId: string;
  receipt: GbpExecutionReceiptV1;
  receiptSha256: string;
  createdAt: string;
}

export interface GbpReadbackAttempt {
  id: string;
  commandId: string;
  observation: GbpReadbackV1 | null;
  observationSha256: string | null;
  diffCodes: string[];
  safeErrorCode: string | null;
  createdAt: string;
}
