"""Dedicated Agent convention and frozen local request; not remote version pinning."""
import hashlib
import json
import os
from datetime import datetime

PROTOCOL = "COREAI_AGENT_PREPARATION_V1"
SNAPSHOT_FIELDS = (
    "id", "type", "status", "published_at", "updated_at", "tools", "skill_ids",
    "subagent_ids", "sandbox_config", "dataset_config", "enable_memory", "model",
    "system_prompt", "system_prompt_id", "response_schema", "input_template",
    "variables", "temperature", "max_turns", "timeout_seconds", "thinking_effort",
    "multi_modal_model", "prefer_caption_path",
)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def valid_id(value):
    return isinstance(value, str) and 0 < len(value) <= 255 and all(
        not c.isspace() and ord(c) >= 33 and ord(c) != 127 for c in value)


def valid_hash(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def agent_snapshot(detail, expected_id):
    if not isinstance(detail, dict) or any(k not in detail for k in SNAPSHOT_FIELDS):
        raise ValueError("Agent 能力配置不完整")
    if detail["id"] != expected_id or not valid_id(expected_id) or detail["type"] != "AGENT" or detail["status"] != "PUBLISHED":
        raise ValueError("Agent 身份或发布状态不符")
    for key in ("published_at", "updated_at"):
        if not isinstance(detail[key], str) or datetime.fromisoformat(detail[key]).tzinfo is None:
            raise ValueError("Agent 发布时间无效")
    if datetime.fromisoformat(detail["published_at"]) != datetime.fromisoformat(detail["updated_at"]):
        raise ValueError("Agent 发布后已被编辑")
    if any(detail[k] not in (None, []) for k in ("tools", "skill_ids", "subagent_ids", "dataset_config")):
        raise ValueError("仅支持无工具、Skill、子 Agent 和数据集的专用 Agent")
    if detail["sandbox_config"] is not None or detail["enable_memory"] is not False:
        raise ValueError("专用 Agent 必须关闭沙箱和记忆")
    return {k: detail[k] for k in SNAPSHOT_FIELDS}


def binding_for_task(conn, task_id):
    row = conn.execute(
        "SELECT a.agent_id,g.coreai_agent_id,g.display_name,g.status FROM task_assignments a "
        "JOIN seo_ops_agents g ON g.id=a.agent_id WHERE a.task_id=? AND a.assignee_type='AGENT'",
        (task_id,),
    ).fetchone()
    if row is None or row["status"] != "active":
        return None
    try:
        raw = os.environ.get("SEO_OPS_TASK_AGENT_BINDINGS", "{}")
        if len(raw) > 65536:
            return None
        bindings = json.loads(raw)
        if not isinstance(bindings, dict):
            return None
        binding = bindings.get(row["agent_id"])
        if (not isinstance(binding, dict) or set(binding) != {"coreai_agent_id", "config_sha256"}
                or not valid_id(binding["coreai_agent_id"])
                or binding["coreai_agent_id"] != row["coreai_agent_id"]
                or not valid_hash(binding["config_sha256"])):
            return None
        return {**binding, "local_agent_id": row["agent_id"], "display_name": row["display_name"]}
    except (TypeError, ValueError):
        return None


def is_agent_request(execution):
    try:
        value = json.loads(execution["request_json"])
        return isinstance(value, dict) and value.get("executor_kind") == PROTOCOL
    except (TypeError, ValueError):
        return False


def validate_agent_request(execution, task=None):
    request = json.loads(execution["request_json"])
    keys = {"executor_kind", "task_id", "workflow_version", "definition_checksum", "stage",
            "input", "local_agent_id", "coreai_agent_id", "agent_name", "config_sha256",
            "agent_snapshot", "operator", "merchant_lifecycle"}
    if not isinstance(request, dict) or set(request) != keys or request["executor_kind"] != PROTOCOL:
        raise ValueError("invalid Agent preparation protocol")
    if (execution["request_json"] != canonical(request) or execution["request_checksum"] != digest(request)
            or request["stage"] != "PREPARATION" or execution["stage"] != "PREPARATION"
            or type(request["task_id"]) is not int or request["task_id"] != execution["task_id"]
            or type(request["workflow_version"]) is not int or request["workflow_version"] < 1
            or not valid_hash(request["definition_checksum"])
            or any(not valid_id(request[k]) for k in ("local_agent_id", "coreai_agent_id"))
            or any(not isinstance(request[k], str) or not request[k].strip() for k in ("input", "operator", "agent_name"))):
        raise ValueError("invalid Agent preparation identity")
    snapshot = agent_snapshot(request["agent_snapshot"], request["coreai_agent_id"])
    if digest(snapshot) != request["config_sha256"]:
        raise ValueError("Agent snapshot checksum mismatch")
    lifecycle = request["merchant_lifecycle"]
    if not isinstance(lifecycle, list) or len(lifecycle) != 2 or type(lifecycle[0]) is not int or lifecycle[0] < 1 or not valid_hash(lifecycle[1]):
        raise ValueError("invalid merchant lifecycle")
    expected = f"task:{execution['task_id']}:preparation:{execution['attempt']}:{execution['request_checksum'][:16]}"
    if execution["idempotency_key"] != expected:
        raise ValueError("invalid Agent preparation idempotency key")
    if task is not None and any(request[k] != task[column] for k, column in (
            ("task_id", "id"), ("workflow_version", "workflow_version"), ("definition_checksum", "definition_checksum"))):
        raise ValueError("Agent preparation Task changed")
    return request
