import json
import re
import sqlite3

from .merchants import now_iso

JSON_BLOCK_RE = re.compile(r"```json\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_plan(report_text: str | None) -> list[dict]:
    for block in JSON_BLOCK_RE.findall(report_text or ""):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        if not isinstance(data, list):
            continue
        items = []
        for entry in data:
            if not isinstance(entry, dict):
                continue
            item_id = entry.get("id")
            title = entry.get("title")
            rationale = entry.get("rationale")
            if not (
                isinstance(item_id, str) and item_id
                and isinstance(title, str) and title
                and isinstance(rationale, str) and rationale
            ):
                continue
            description = entry.get("description")
            items.append({
                "id": item_id,
                "title": title,
                "rationale": rationale,
                "description": description if isinstance(description, str) and description else None,
            })
        if items:
            return items
    return []


def create_tasks_from_plan(
    conn: sqlite3.Connection,
    merchant_id: int,
    run_id: int,
    coreai_run_id: str,
    items: list[dict],
) -> int:
    created = 0
    for item in items:
        source_key = f"plan-{coreai_run_id}-{item['id']}"
        cur = conn.execute(
            "INSERT OR IGNORE INTO tasks"
            " (merchant_id, title, description, rationale, source_run_id, source_key, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (merchant_id, item["title"], item["description"], item["rationale"], run_id, source_key, now_iso()),
        )
        created += cur.rowcount
    return created
