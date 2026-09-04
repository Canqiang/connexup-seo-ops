"""Append-only audit events for Task workflow aggregates."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def append_task_event(
    conn: sqlite3.Connection,
    *,
    entity_type: str,
    entity_id: int,
    event_type: str,
    actor_type: str,
    actor_id: str | None,
    payload: object,
) -> int:
    """Append one canonical event without committing the caller's transaction."""

    created_at = datetime.now(timezone.utc).isoformat()
    cursor = conn.execute(
        "INSERT INTO task_events "
        "(entity_type, entity_id, event_type, actor_type, actor_id, payload_json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            entity_type,
            entity_id,
            event_type,
            actor_type,
            actor_id,
            _canonical_json(payload),
            created_at,
        ),
    )
    return int(cursor.lastrowid)


__all__ = ["append_task_event"]
