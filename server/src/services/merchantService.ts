import crypto from "node:crypto";
import { isUniqueViolation, type Db } from "../db/connection.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { requestFingerprint } from "../domain/hashing.js";
import {
  findMerchantByIdempotencyKey,
  getMerchant,
  insertMerchant,
  listMerchants,
} from "../repos/merchantRepo.js";
import {
  findLocationByIdempotencyKey,
  insertLocation,
  listLocationsByMerchant,
} from "../repos/locationRepo.js";
import type { LocationReadiness } from "../domain/enums.js";
import type { Location, Merchant } from "../repos/types.js";
import { getUserById } from "../repos/userRepo.js";
import { ApiError } from "../errors.js";

const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** Keys are used as plain-object map entries (mutationKeys) and must stay
 * safe property names — reject "__proto__" and friends up front. UUIDs and
 * short human keys both fit. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function requireIdempotencyKey(value: unknown, field: string): string {
  const key = requireNonEmpty(value, field);
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw badRequest(
      `${field} must match ${IDEMPOTENCY_KEY_PATTERN.source} (alphanumerics, . _ : -)`,
    );
  }
  return key;
}

export function normalizeSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw badRequest(
      `slug must match ${SLUG_PATTERN.source} (lowercase letters, digits, hyphens)`,
    );
  }
  return slug;
}

export interface CreateMerchantInput {
  slug: string;
  displayName?: string | null;
  tags?: string[] | null;
  operatorUserIds?: string[] | null;
  /** Request-scoped onboarding facts used by downstream orchestration. */
  intakeContext?: Record<string, unknown> | null;
  idempotencyKey: string;
  createdBy?: string | null;
  /** The authenticated creator is always an operator, preventing invisible
   * merchants created with an empty or unrelated operator list. */
  actorUserId: string;
}

export interface CreateLocationInput {
  slug: string;
  displayName?: string | null;
  timezone?: string | null;
  externalIdentities?: Record<string, string> | null;
  readinessStatus: LocationReadiness;
  missingRequirements?: string[] | null;
  idempotencyKey: string;
  createdBy?: string | null;
}

export interface MutationResult<T> {
  entity: T;
  replayed: boolean;
}

/**
 * Idempotency replay semantics, shared by all creation paths:
 * - same key + same fingerprint -> return the existing row (replay)
 * - same key + different fingerprint -> 409 IDEMPOTENCY_CONFLICT
 */
export function resolveIdempotentCreate<T extends {
  requestFingerprint: string | null;
}>(existing: T | null, fingerprint: string): T | null {
  if (!existing) return null;
  if (existing.requestFingerprint === fingerprint) return existing;
  throw conflict(
    "idempotency key already used with a different request body",
    "IDEMPOTENCY_CONFLICT",
  );
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalStrings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || v.trim() === "")
  ) {
    throw badRequest(`${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function createMerchant(
  db: Db,
  input: CreateMerchantInput,
): Promise<MutationResult<Merchant>> {
  const key = requireIdempotencyKey(input.idempotencyKey, "idempotency_key");
  const slug = normalizeSlug(requireNonEmpty(input.slug, "slug"));
  const displayName = input.displayName ?? slug;
  const tags = optionalStrings(input.tags, "tags");
  const requestedOperatorUserIds = optionalStrings(
    input.operatorUserIds,
    "operator_user_ids",
  );
  const operatorUserIds = [...new Set([input.actorUserId, ...requestedOperatorUserIds])];
  for (const operatorUserId of operatorUserIds) {
    const operator = await getUserById(db, operatorUserId);
    if (!operator || operator.status !== "ACTIVE" || operator.identityType !== "HUMAN") {
      throw new ApiError(400, `operator ${operatorUserId} is not an active human user`, "INVALID_OPERATOR");
    }
  }
  const fingerprint = requestFingerprint({
    slug,
    display_name: displayName,
    tags,
    operator_user_ids: operatorUserIds,
    intake_context: input.intakeContext ?? null,
  });

  return db.withTransaction(async (tx) => {
    const existing = await findMerchantByIdempotencyKey(tx, key);
    const replay = resolveIdempotentCreate(existing, fingerprint);
    if (replay) return { entity: replay, replayed: true };

    const merchant: Merchant = {
      id: crypto.randomUUID(),
      slug,
      displayName,
      tags,
      operatorUserIds,
      creationIdempotencyKey: key,
      requestFingerprint: fingerprint,
      createdBy: input.createdBy ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    try {
      await insertMerchant(tx, merchant);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict(`merchant slug "${slug}" already exists`, "DUPLICATE_SLUG");
      }
      throw err;
    }
    return { entity: merchant, replayed: false };
  });
}

function validateLocationSemantics(input: CreateLocationInput): {
  readiness: LocationReadiness;
  missing: string[];
  identities: Record<string, string>;
} {
  const readiness = input.readinessStatus;
  if (readiness !== "READY" && readiness !== "BLOCKED" && readiness !== "INCOMPLETE") {
    throw badRequest(
      `readiness_status must be one of READY/BLOCKED/INCOMPLETE, got ${JSON.stringify(readiness)}`,
    );
  }
  const missing = optionalStrings(input.missingRequirements, "missing_requirements");
  const identities = input.externalIdentities ?? {};
  if (typeof identities !== "object" || Array.isArray(identities)) {
    throw badRequest(`external_identities must be an object of string -> string`);
  }

  if (readiness === "READY") {
    if (missing.length > 0) {
      throw badRequest(
        `readiness_status=READY requires empty missing_requirements, got ${missing.length}`,
      );
    }
    const usable = Object.values(identities).filter(
      (v) => typeof v === "string" && v.trim() !== "",
    );
    if (usable.length === 0) {
      throw badRequest(
        `readiness_status=READY requires at least one non-empty external identity`,
      );
    }
  }

  if (readiness === "BLOCKED" || readiness === "INCOMPLETE") {
    if (missing.length === 0) {
      throw badRequest(
        `readiness_status=${readiness} requires at least one missing_requirement`,
      );
    }
  }
  return { readiness, missing, identities };
}

export async function createLocation(
  db: Db,
  merchantId: string,
  input: CreateLocationInput,
): Promise<MutationResult<Location>> {
  const key = requireIdempotencyKey(input.idempotencyKey, "idempotency_key");
  const slug = normalizeSlug(requireNonEmpty(input.slug, "slug"));
  const merchant = await getMerchant(db, merchantId);
  if (!merchant) throw notFound(`merchant ${merchantId} not found`);

  const { readiness, missing, identities } = validateLocationSemantics(input);
  const displayName = input.displayName ?? slug;
  const fingerprint = requestFingerprint({
    merchant_id: merchantId,
    slug,
    display_name: displayName,
    timezone: input.timezone ?? null,
    external_identities: identities,
    readiness_status: readiness,
    missing_requirements: missing,
  });

  return db.withTransaction(async (tx) => {
    const existing = await findLocationByIdempotencyKey(tx, key);
    const replay = resolveIdempotentCreate(existing, fingerprint);
    if (replay) return { entity: replay, replayed: true };

    const location: Location = {
      id: crypto.randomUUID(),
      merchantId,
      slug,
      displayName,
      timezone: input.timezone ?? null,
      externalIdentities: identities,
      readinessStatus: readiness,
      missingRequirements: missing,
      creationIdempotencyKey: key,
      requestFingerprint: fingerprint,
      createdBy: input.createdBy ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    try {
      await insertLocation(tx, location);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw conflict(
          `location slug "${slug}" already exists for this merchant`,
          "DUPLICATE_SLUG",
        );
      }
      throw err;
    }
    return { entity: location, replayed: false };
  });
}

export { getMerchant, listMerchants, listLocationsByMerchant };
