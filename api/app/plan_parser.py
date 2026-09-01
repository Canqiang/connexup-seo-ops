import json
import re
import sqlite3
from datetime import datetime, timedelta, timezone

from .merchants import now_iso
from .tasks import TASK_CATEGORIES

JSON_BLOCK_RE = re.compile(r"```json\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_plan(report_text: str | None) -> list[dict]:
    text = report_text or ""
    candidates = JSON_BLOCK_RE.findall(text)
    # 容错：模型偶发漏掉收尾的 ```，把最后一个 ```json 到文末当作候选块
    idx = text.rfind("```json")
    if idx != -1:
        candidates.append(text[idx + len("```json"):].strip().strip("`").strip())
    for block in candidates:
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
            expected_outcome = entry.get("expected_outcome")
            category = entry.get("category")
            if category is not None:
                category = category if category in TASK_CATEGORIES else "other"
            start_after = entry.get("start_after_days")
            if isinstance(start_after, int) and not isinstance(start_after, bool) and start_after >= 0:
                scheduled_start = (datetime.now(timezone.utc) + timedelta(days=start_after)).isoformat()
            else:
                scheduled_start = None
            items.append({
                "id": item_id,
                "title": title,
                "rationale": rationale,
                "expected_outcome": expected_outcome if isinstance(expected_outcome, str) and expected_outcome else None,
                "category": category,
                "scheduled_start": scheduled_start,
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
            " (merchant_id, title, description, rationale, expected_outcome, category, scheduled_start, source_run_id, source_key, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (merchant_id, item["title"], item["description"], item["rationale"], item["expected_outcome"], item["category"], item["scheduled_start"], run_id, source_key, now_iso()),
        )
        created += cur.rowcount
    return created
