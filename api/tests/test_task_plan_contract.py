import copy
import hashlib
import json
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError


def _task(key="draft", **overrides):
    task = {
        "key": key,
        "task_type": "PREPARE_ONLY",
        "title": "Draft content",
        "rationale": "Create the content first",
        "expected_outcome": "A reviewable draft",
        "depends_on": [],
        "parameters": {"description": "Draft one post"},
    }
    task.update(overrides)
    return task


@pytest.fixture()
def valid_plan():
    return {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [
            _task(
                "review",
                title="Review content",
                rationale="Catch unsupported claims",
                expected_outcome="A reviewable decision",
                depends_on=["draft"],
                parameters={"description": "Review the prepared copy"},
            ),
            _task("draft"),
        ],
    }


def test_valid_plan_is_canonical_and_sorted_into_waves(valid_plan):
    from app.task_plan_contract import validate_task_plan

    plan = validate_task_plan(valid_plan, {"PREPARE_ONLY"})

    assert plan.waves == [["draft"], ["review"]]
    assert plan.checksum == hashlib.sha256(plan.canonical_json.encode()).hexdigest()
    assert plan.canonical_json == json.dumps(
        plan.payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )


@pytest.mark.parametrize(
    "field",
    ["task_type", "title", "rationale", "expected_outcome"],
)
def test_task_plan_item_rejects_blank_required_text(field):
    from app.task_plan_contract import TaskPlanItem

    item = _task()
    item[field] = " \t\n "

    with pytest.raises(ValidationError):
        TaskPlanItem.model_validate(item)


def test_required_human_text_is_trimmed_before_canonicalization(valid_plan):
    from app.task_plan_contract import validate_task_plan

    valid_plan["tasks"][0].update(
        title="  Review content \n",
        rationale="\tCatch unsupported claims  ",
        expected_outcome="  A reviewable decision\t",
    )

    plan = validate_task_plan(valid_plan, {"PREPARE_ONLY"})
    review = next(item for item in plan.payload["tasks"] if item["key"] == "review")

    assert review["title"] == "Review content"
    assert review["rationale"] == "Catch unsupported claims"
    assert review["expected_outcome"] == "A reviewable decision"


def test_task_type_is_not_silently_trimmed_into_an_enabled_type(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"][0]["task_type"] = " PREPARE_ONLY "

    with pytest.raises(TaskPlanValidationError) as exc:
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})

    assert exc.value.codes == ["task_type_disabled"]


@pytest.mark.parametrize(
    "mutate,error_code",
    [
        (lambda p: p.update(extra=True), "unknown_field"),
        (lambda p: p.update(schema_version="seo_ops.task_plan.v0"), "schema_version"),
        (lambda p: p["tasks"][0].update(key="Bad Key"), "task_key"),
        (lambda p: p["tasks"][0].update(task_type="GBP_POST"), "task_type_disabled"),
        (lambda p: p["tasks"][0].update(depends_on=["missing"]), "missing_dependency"),
        (lambda p: p["tasks"][0].update(depends_on=["review"]), "self_dependency"),
    ],
)
def test_invalid_plan_is_rejected_as_one_revision(valid_plan, mutate, error_code):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    mutate(valid_plan)
    with pytest.raises(TaskPlanValidationError) as exc:
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})
    assert error_code in exc.value.codes


def test_duplicate_keys_are_rejected(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"][1]["key"] = "review"
    with pytest.raises(TaskPlanValidationError, match="duplicate_key"):
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})


def test_duplicate_dependency_edges_are_rejected(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"][0]["depends_on"] = ["draft", "draft"]
    with pytest.raises(TaskPlanValidationError, match="duplicate_dependency"):
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})


def test_two_node_cycle_is_rejected(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"][0]["depends_on"] = ["draft"]
    valid_plan["tasks"][1]["depends_on"] = ["review"]
    with pytest.raises(TaskPlanValidationError, match="cycle"):
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})


def test_more_than_50_tasks_is_rejected(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"] = [_task(f"task-{i}") for i in range(51)]
    with pytest.raises(TaskPlanValidationError) as exc:
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})
    assert {"task_count", "max_tasks"} & set(exc.value.codes)


def test_more_than_20_dependencies_is_rejected(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"] = [_task(f"task-{i}") for i in range(22)]
    valid_plan["tasks"][-1]["depends_on"] = [f"task-{i}" for i in range(21)]
    with pytest.raises(TaskPlanValidationError) as exc:
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})
    assert {"dependency_count", "max_dependencies"} & set(exc.value.codes)


def test_naive_scheduled_start_is_rejected(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"][0]["scheduled_start"] = "2026-09-05T13:00:00"
    with pytest.raises(TaskPlanValidationError, match="scheduled_start"):
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})


@pytest.mark.parametrize(
    "scheduled_start",
    [
        0,
        1_725_541_200.5,
        "2026-09-05 13:00:00+00:00",
        "2026-09-05T13:00+00:00",
        datetime(2026, 9, 5, 13, 0, tzinfo=timezone.utc),
    ],
    ids=["integer", "float", "space-separated", "seconds-omitted", "datetime-object"],
)
def test_scheduled_start_rejects_non_rfc3339_string_inputs(valid_plan, scheduled_start):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"][0]["scheduled_start"] = scheduled_start

    with pytest.raises(TaskPlanValidationError) as exc:
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})

    assert exc.value.codes == ["scheduled_start"]


def test_parameters_above_64_kib_are_rejected(valid_plan, monkeypatch):
    from pydantic import BaseModel, ConfigDict

    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    class LargeParameters(BaseModel):
        model_config = ConfigDict(extra="forbid")
        description: str

    monkeypatch.setitem(
        __import__("app.task_plan_contract", fromlist=["TASK_PARAMETER_MODELS"]).TASK_PARAMETER_MODELS,
        "PREPARE_ONLY",
        LargeParameters,
    )
    valid_plan["tasks"][0]["parameters"] = {"description": "x" * (64 * 1024)}
    with pytest.raises(TaskPlanValidationError) as exc:
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})
    assert {"parameters_size", "parameters_too_large", "parameters"} & set(exc.value.codes)


def test_plan_above_1_mib_is_rejected(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    valid_plan["tasks"] = [
        _task(
            f"task-{i}",
            title="字" * 200,
            rationale="字" * 2000,
            expected_outcome="字" * 1000,
            parameters={"description": "字" * 4000},
        )
        for i in range(50)
    ]
    with pytest.raises(TaskPlanValidationError) as exc:
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})
    assert {"plan_size", "plan_too_large"} & set(exc.value.codes)


def test_report_with_two_valid_plan_objects_is_ambiguous(valid_plan):
    from app.task_plan_contract import TaskPlanValidationError, extract_task_plan

    first = json.dumps(valid_plan)
    second = json.dumps(copy.deepcopy(valid_plan))
    report = f"```json\n{first}\n```\n```json\n{second}\n```"
    with pytest.raises(TaskPlanValidationError, match="ambiguous"):
        extract_task_plan(report, {"PREPARE_ONLY"})


def test_report_without_one_valid_plan_returns_none(valid_plan):
    from app.task_plan_contract import extract_task_plan

    assert extract_task_plan("No plan was generated.", {"PREPARE_ONLY"}) is None
    assert extract_task_plan("```json\n[]\n```", {"PREPARE_ONLY"}) is None


def test_unterminated_fenced_plan_is_not_extracted(valid_plan):
    from app.task_plan_contract import extract_task_plan

    report = f"Report\n```json\n{json.dumps(valid_plan)}"
    assert extract_task_plan(report, {"PREPARE_ONLY"}) is None


def test_report_with_one_valid_fenced_plan_is_extracted(valid_plan):
    from app.task_plan_contract import extract_task_plan

    plan = extract_task_plan(f"Report\n```json\n{json.dumps(valid_plan)}\n```", {"PREPARE_ONLY"})
    assert plan is not None
    assert plan.waves == [["draft"], ["review"]]
