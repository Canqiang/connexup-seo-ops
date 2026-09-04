import json

import pytest


def execution_result(**overrides) -> str:
    value = {
        "outcome": "ready",
        "summary": "Prepared a reviewable artifact",
        "artifact_refs": ["artifact://result-v1"],
        "evidence": ["Generated from verified merchant context"],
        "external_write_performed": False,
    }
    value.update(overrides)
    return json.dumps(value)


@pytest.mark.parametrize("field", ["artifact_refs", "evidence"])
def test_execution_result_rejects_unbounded_reference_lists(field):
    from app.execution_result import normalize_execution_output

    with pytest.raises(ValueError, match=field):
        normalize_execution_output(
            execution_result(**{field: [f"item-{index}" for index in range(51)]})
        )


def test_execution_result_rejects_an_oversized_summary():
    from app.execution_result import normalize_execution_output

    with pytest.raises(ValueError, match="summary"):
        normalize_execution_output(execution_result(summary="x" * 4001))


@pytest.mark.parametrize("field", ["artifact_refs", "evidence"])
def test_execution_result_rejects_oversized_list_fields(field):
    from app.execution_result import normalize_execution_output

    with pytest.raises(ValueError, match=field):
        normalize_execution_output(execution_result(**{field: ["x" * 2001]}))


def test_execution_result_rejects_an_oversized_serialized_payload_before_parse():
    from app.execution_result import normalize_execution_output

    with pytest.raises(ValueError, match="too large"):
        normalize_execution_output(" " * (256 * 1024 + 1))
