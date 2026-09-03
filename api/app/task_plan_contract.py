"""Strict, versioned contract for task plans emitted by an Agent.

The functions in this module deliberately treat their inputs as untrusted.  A
plan is accepted only when the complete object and every task pass validation;
there is no best-effort or partial-plan path.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

MAX_PARAMETERS_BYTES = 64 * 1024
MAX_PLAN_BYTES = 1024 * 1024


class TaskPlanItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(pattern=r"^[a-z0-9_-]{1,80}$")
    task_type: str
    title: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=1, max_length=2000)
    expected_outcome: str = Field(min_length=1, max_length=1000)
    depends_on: list[str] = Field(default_factory=list, max_length=20)
    scheduled_start: AwareDatetime | None = None
    parameters: dict[str, object] = Field(default_factory=dict)


class TaskPlanPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["seo_ops.task_plan.v1"]
    tasks: list[TaskPlanItem] = Field(min_length=1, max_length=50)


class PrepareOnlyParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: str | None = Field(default=None, max_length=4000)
    category: Literal["gbp", "content", "review", "citation", "technical", "other"] | None = None


TASK_PARAMETER_MODELS: dict[str, type[BaseModel]] = {
    "PREPARE_ONLY": PrepareOnlyParameters,
}


@dataclass(frozen=True)
class ValidatedTaskPlan:
    payload: dict[str, object]
    canonical_json: str
    checksum: str
    waves: list[list[str]]


class TaskPlanValidationError(ValueError):
    """Raised when any part of a plan fails strict validation."""

    def __init__(self, codes: list[str]):
        unique_codes = list(dict.fromkeys(codes))
        self.codes = unique_codes
        super().__init__("invalid task plan: " + ", ".join(unique_codes))


def _error_code(error: dict[str, object]) -> str:
    """Convert Pydantic's detailed error into a stable contract code."""

    loc = error.get("loc", ())
    loc = tuple(loc) if isinstance(loc, (tuple, list)) else ()
    error_type = str(error.get("type", ""))
    if error_type == "extra_forbidden":
        return "unknown_field"
    if loc and loc[0] == "schema_version":
        return "schema_version"
    if loc and loc[0] == "tasks":
        if len(loc) > 2 and isinstance(loc[1], int) and loc[2] == "depends_on":
            if error_type in {"too_long", "list_too_long"}:
                return "dependency_count"
            return "depends_on"
        if error_type in {"too_short", "too_long", "list_too_short", "list_too_long"}:
            return "task_count"
        if len(loc) > 1 and isinstance(loc[1], int):
            if len(loc) > 2 and loc[2] == "key":
                return "task_key"
            if len(loc) > 2 and loc[2] == "scheduled_start":
                return "scheduled_start"
            if len(loc) > 2 and loc[2] == "parameters":
                return "parameters"
    if error_type in {"timezone_naive", "datetime_object_invalid"}:
        return "scheduled_start_naive"
    return "invalid_field"


def _validate_payload(raw: object) -> tuple[TaskPlanPayload | None, list[str]]:
    if not isinstance(raw, Mapping):
        return None, ["plan_type"]
    try:
        return TaskPlanPayload.model_validate(raw), []
    except ValidationError as exc:
        return None, [_error_code(error) for error in exc.errors()]


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _parameter_model(task_type: str, enabled_task_types: set[str]) -> type[BaseModel] | None:
    if task_type not in enabled_task_types:
        return None
    return TASK_PARAMETER_MODELS.get(task_type)


def _waves(tasks: list[TaskPlanItem]) -> tuple[list[list[str]], list[str]]:
    order = [task.key for task in tasks]
    keys = set(order)
    indegree = {key: 0 for key in order}
    downstream = {key: [] for key in order}
    codes: list[str] = []

    for task in tasks:
        seen: set[str] = set()
        for dependency in task.depends_on:
            if dependency in seen:
                codes.extend(("duplicate_dependency", "duplicate_edge"))
            seen.add(dependency)
            if dependency == task.key:
                codes.append("self_dependency")
            elif dependency not in keys:
                codes.append("missing_dependency")
            else:
                indegree[task.key] += 1
                downstream[dependency].append(task.key)

    if codes:
        return [], list(dict.fromkeys(codes))

    remaining = set(order)
    waves: list[list[str]] = []
    while remaining:
        ready = [key for key in order if key in remaining and indegree[key] == 0]
        if not ready:
            return [], ["cycle"]
        waves.append(ready)
        for key in ready:
            remaining.remove(key)
            for child in downstream[key]:
                indegree[child] -= 1
    return waves, []


def validate_task_plan(raw: object, enabled_task_types: set[str]) -> ValidatedTaskPlan:
    """Validate and normalize one complete task plan."""

    payload_model, codes = _validate_payload(raw)
    if codes or payload_model is None:
        raise TaskPlanValidationError(codes)

    tasks = payload_model.tasks
    task_codes: list[str] = []
    keys: set[str] = set()
    normalized_tasks: list[dict[str, object]] = []
    for task in tasks:
        if task.key in keys:
            task_codes.append("duplicate_key")
        keys.add(task.key)

        parameter_type = _parameter_model(task.task_type, enabled_task_types)
        if parameter_type is None:
            task_codes.append("task_type_disabled")
            continue
        try:
            parameters = parameter_type.model_validate(task.parameters)
        except ValidationError as exc:
            task_codes.extend(_parameter_error_code(error) for error in exc.errors())
            continue
        parameter_payload = parameters.model_dump(mode="json")
        parameter_json = _canonical_json(parameter_payload)
        if len(parameter_json.encode("utf-8")) > MAX_PARAMETERS_BYTES:
            task_codes.extend(("parameters_size", "parameters_too_large"))
            continue
        normalized_task = task.model_dump(mode="json")
        normalized_task["parameters"] = parameter_payload
        normalized_tasks.append(normalized_task)

    if task_codes:
        raise TaskPlanValidationError(task_codes)

    waves, graph_codes = _waves(tasks)
    if graph_codes:
        raise TaskPlanValidationError(graph_codes)

    normalized_payload = {
        "schema_version": payload_model.schema_version,
        "tasks": normalized_tasks,
    }
    canonical_json = _canonical_json(normalized_payload)
    if len(canonical_json.encode("utf-8")) > MAX_PLAN_BYTES:
        raise TaskPlanValidationError(["plan_size", "plan_too_large"])
    return ValidatedTaskPlan(
        payload=normalized_payload,
        canonical_json=canonical_json,
        checksum=hashlib.sha256(canonical_json.encode("utf-8")).hexdigest(),
        waves=waves,
    )


def _parameter_error_code(error: dict[str, object]) -> str:
    if error.get("type") == "extra_forbidden":
        return "unknown_field"
    return "parameters"


_JSON_FENCE_RE = re.compile(r"```json\s*(.*?)```", re.IGNORECASE | re.DOTALL)


def extract_task_plan(report_text: object, enabled_task_types: set[str]) -> ValidatedTaskPlan | None:
    """Extract exactly one valid JSON Plan object from a Run report.

    Invalid fenced candidates are ignored so an Agent's surrounding prose or a
    malformed example cannot produce a Plan.  More than one valid candidate is
    an explicit ambiguity and is rejected.
    """

    if not isinstance(report_text, str):
        return None
    candidates = list(_JSON_FENCE_RE.findall(report_text))
    # Accept a final fence omitted by an Agent, while avoiding duplicate capture
    # when a normal closed fence was already found.
    if not candidates:
        marker = re.search(r"```json\s*", report_text, re.IGNORECASE)
        if marker:
            candidates.append(report_text[marker.end() :].strip().strip("`").strip())

    valid: list[ValidatedTaskPlan] = []
    for candidate in candidates:
        try:
            raw = json.loads(candidate)
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        try:
            valid.append(validate_task_plan(raw, enabled_task_types))
        except TaskPlanValidationError:
            continue

    if len(valid) > 1:
        raise TaskPlanValidationError(["ambiguous_plan", "ambiguous"])
    return valid[0] if valid else None


__all__ = [
    "PrepareOnlyParameters",
    "TASK_PARAMETER_MODELS",
    "TaskPlanItem",
    "TaskPlanPayload",
    "TaskPlanValidationError",
    "ValidatedTaskPlan",
    "extract_task_plan",
    "validate_task_plan",
]
