import json
import re


JSON_FENCE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL | re.IGNORECASE)


def normalize_execution_output(raw: object) -> str:
    if not isinstance(raw, str) or not raw.strip():
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
    summary = value.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        raise ValueError("agent result summary is required")
    for field in ("artifact_refs", "evidence"):
        items = value.get(field)
        if not isinstance(items, list) or any(not isinstance(item, str) or not item.strip() for item in items):
            raise ValueError(f"agent result {field} must be a string list")
    if not value["artifact_refs"] and not value["evidence"]:
        raise ValueError("agent result requires an artifact or evidence reference")
    normalized = {
        "outcome": "ready",
        "summary": summary.strip(),
        "artifact_refs": value["artifact_refs"],
        "evidence": value["evidence"],
        "external_write_performed": False,
    }
    return json.dumps(normalized, ensure_ascii=False, indent=2)
