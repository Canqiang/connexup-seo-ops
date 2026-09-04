import json
import re


JSON_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL | re.IGNORECASE)
MAX_EXECUTION_RESULT_BYTES = 256 * 1024
MAX_EXECUTION_SUMMARY_CHARS = 4000
MAX_EXECUTION_LIST_ITEMS = 50
MAX_EXECUTION_LIST_ITEM_CHARS = 2000


def normalize_execution_output(raw: object) -> str:
    if not isinstance(raw, str):
        raise ValueError("agent result must be a non-empty structured JSON object")
    if len(raw.encode("utf-8")) > MAX_EXECUTION_RESULT_BYTES:
        raise ValueError("agent result is too large")
    if not raw.strip():
        raise ValueError("agent result must be a non-empty structured JSON object")
    text = raw.strip()
    fenced = JSON_FENCE.match(text)
    if fenced:
        text = fenced.group(1).strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("agent result must be structured JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("agent result must be a structured JSON object")
    if value.get("external_write_performed") is not False:
        raise ValueError("agent reported an unauthorized external write")
    if value.get("outcome") != "ready":
        raise ValueError("agent result is not ready and requires operator input")
    raw_summary = value.get("summary")
    if not isinstance(raw_summary, str) or not raw_summary.strip():
        raise ValueError("agent result summary is required")
    summary = raw_summary.strip()
    if len(summary) > MAX_EXECUTION_SUMMARY_CHARS:
        raise ValueError("agent result summary is too long")
    normalized_lists: dict[str, list[str]] = {}
    for field in ("artifact_refs", "evidence"):
        items = value.get(field)
        if not isinstance(items, list) or any(not isinstance(item, str) or not item.strip() for item in items):
            raise ValueError(f"agent result {field} must be a string list")
        if len(items) > MAX_EXECUTION_LIST_ITEMS:
            raise ValueError(f"agent result {field} has too many items")
        normalized_items = [item.strip() for item in items]
        if any(len(item) > MAX_EXECUTION_LIST_ITEM_CHARS for item in normalized_items):
            raise ValueError(f"agent result {field} contains an oversized item")
        normalized_lists[field] = normalized_items
    if not value["artifact_refs"] and not value["evidence"]:
        raise ValueError("agent result requires an artifact or evidence reference")
    normalized = {
        "outcome": "ready",
        "summary": summary,
        "artifact_refs": normalized_lists["artifact_refs"],
        "evidence": normalized_lists["evidence"],
        "external_write_performed": False,
    }
    serialized = json.dumps(normalized, ensure_ascii=False, indent=2)
    if len(serialized.encode("utf-8")) > MAX_EXECUTION_RESULT_BYTES:
        raise ValueError("agent result is too large")
    return serialized
