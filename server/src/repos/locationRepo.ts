import type { Db } from "../db/connection.js";
import type { LocationReadiness } from "../domain/enums.js";
import type { Location } from "./types.js";

interface LocationRow {
  id: string;
  merchant_id: string;
  slug: string;
  display_name: string;
  timezone: string | null;
  external_identities: string;
  readiness_status: string;
  missing_requirements: string;
  creation_idempotency_key: string | null;
  request_fingerprint: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toLocation(row: LocationRow): Location {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    slug: row.slug,
    displayName: row.display_name,
    timezone: row.timezone,
    externalIdentities: JSON.parse(row.external_identities || "{}"),
    readinessStatus: row.readiness_status as LocationReadiness,
    missingRequirements: JSON.parse(row.missing_requirements || "[]"),
    creationIdempotencyKey: row.creation_idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertLocation(db: Db, location: Location): Promise<Location> {
  await db.exec(
    `INSERT INTO seo_locations
      (id, merchant_id, slug, display_name, timezone, external_identities,
       readiness_status, missing_requirements,
       creation_idempotency_key, request_fingerprint, created_by,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      location.id,
      location.merchantId,
      location.slug,
      location.displayName,
      location.timezone,
      JSON.stringify(location.externalIdentities),
      location.readinessStatus,
      JSON.stringify(location.missingRequirements),
      location.creationIdempotencyKey,
      location.requestFingerprint,
      location.createdBy,
      location.createdAt,
      location.updatedAt,
    ],
  );
  return location;
}

export async function getLocation(db: Db, id: string): Promise<Location | null> {
  const row = await db.one<LocationRow>(`SELECT * FROM seo_locations WHERE id = $1`, [id]);
  return row ? toLocation(row) : null;
}

export async function findLocationByIdempotencyKey(
  db: Db,
  key: string,
): Promise<Location | null> {
  const row = await db.one<LocationRow>(
    `SELECT * FROM seo_locations WHERE creation_idempotency_key = $1`,
    [key],
  );
  return row ? toLocation(row) : null;
}

export async function listLocationsByMerchant(db: Db, merchantId: string): Promise<Location[]> {
  const rows = await db.query<LocationRow>(
    `SELECT * FROM seo_locations WHERE merchant_id = $1 ORDER BY display_name`,
    [merchantId],
  );
  return rows.map(toLocation);
}

export async function listLocations(db: Db): Promise<Location[]> {
  const rows = await db.query<LocationRow>(
    `SELECT * FROM seo_locations ORDER BY merchant_id, display_name`,
  );
  return rows.map(toLocation);
}
