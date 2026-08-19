import type {
  LocationReadiness,
} from "../domain/enums.js";

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
