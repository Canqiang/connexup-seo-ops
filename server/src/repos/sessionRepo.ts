import type { Db } from "../db/connection.js";

export interface SeoSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_seen_at: string;
}

function toSession(row: SessionRow): SeoSession {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export async function insertSession(db: Db, session: SeoSession): Promise<void> {
  await db.exec(
    `INSERT INTO seo_sessions
      (id, user_id, token_hash, expires_at, revoked_at, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      session.id,
      session.userId,
      session.tokenHash,
      session.expiresAt,
      session.revokedAt,
      session.createdAt,
      session.lastSeenAt,
    ],
  );
}

export async function getActiveSessionByHash(
  db: Db,
  tokenHash: string,
  nowIso: string,
): Promise<SeoSession | null> {
  const row = await db.one<SessionRow>(
    `SELECT * FROM seo_sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [tokenHash, nowIso],
  );
  return row ? toSession(row) : null;
}

export async function revokeSessionByHash(db: Db, tokenHash: string, at: string): Promise<void> {
  await db.exec(
    `UPDATE seo_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash, at],
  );
}

export async function deleteExpiredSessions(db: Db, nowIso: string): Promise<number> {
  return db.exec(`DELETE FROM seo_sessions WHERE expires_at <= $1`, [nowIso]);
}
