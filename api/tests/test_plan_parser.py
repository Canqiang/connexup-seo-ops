VALID_REPORT = """# 分析报告

一些前文。

```json
[
  {"id": "item-1", "title": "修复 GBP 营业时间", "rationale": "营业时间与官网不一致", "description": "改成 9-18"},
  {"id": "item-2", "title": "补充商户照片", "rationale": "照片数量低于同行"}
]
```

一些后文。
"""


def test_extract_plan_parses_valid_block():
    from app.plan_parser import extract_plan

    items = extract_plan(VALID_REPORT)
    assert len(items) == 2
    assert items[0] == {
        "id": "item-1",
        "title": "修复 GBP 营业时间",
        "rationale": "营业时间与官网不一致",
        "expected_outcome": None,
        "category": None,
        "scheduled_start": None,
        "description": "改成 9-18",
    }
    assert items[1]["description"] is None


def test_extract_plan_skips_invalid_entries():
    from app.plan_parser import extract_plan

    report = '```json\n[{"id": "a", "title": "t", "rationale": "r"}, {"id": "b", "title": ""}, "junk"]\n```'
    items = extract_plan(report)
    assert [i["id"] for i in items] == ["a"]


def test_extract_plan_no_block_or_bad_json_returns_empty():
    from app.plan_parser import extract_plan

    assert extract_plan("没有代码块的普通报告") == []
    assert extract_plan("```json\n{not json}\n```") == []
    assert extract_plan("") == []
    assert extract_plan(None) == []


def test_legacy_plan_materialization_is_disabled_and_creates_no_formal_tasks(client):
    import pytest

    from app.db import connect
    from app.plan_parser import create_tasks_from_plan, extract_plan

    m = client.post(
        "/api/merchants",
        json={"name": "M", "primary_location": "New York, NY"},
    ).json()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
            " VALUES (?, 'core-r1', 'running', 'manual', '2026-08-31T00:00:00+00:00')",
            (m["id"],),
        )
        run_id = conn.execute("SELECT id FROM runs").fetchone()["id"]
        items = extract_plan(VALID_REPORT)
        with pytest.raises(
            RuntimeError,
            match="legacy Plan materialization is disabled; use strict Plan persistence and approval",
        ):
            create_tasks_from_plan(conn, m["id"], run_id, "core-r1", items)
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
    finally:
        conn.rollback()
        conn.close()


def test_extract_plan_carries_expected_outcome():
    from app.plan_parser import extract_plan

    report = (
        '```json\n'
        '[{"id": "a", "title": "T", "rationale": "R", "expected_outcome": "E"},'
        ' {"id": "b", "title": "T2", "rationale": "R2"}]\n'
        '```'
    )
    items = extract_plan(report)
    assert items[0]["expected_outcome"] == "E"
    assert items[1]["expected_outcome"] is None


def test_extract_plan_tolerates_unclosed_fence():
    from app.plan_parser import extract_plan

    report = '# 报告\n\n```json\n[{"id": "x", "title": "T", "rationale": "R", "expected_outcome": "E"}]'
    items = extract_plan(report)
    assert [i["id"] for i in items] == ["x"]
    assert items[0]["expected_outcome"] == "E"


def test_extract_plan_category_validated():
    from app.plan_parser import extract_plan

    report = (
        '```json\n'
        '[{"id": "a", "title": "T", "rationale": "R", "category": "gbp"},'
        ' {"id": "b", "title": "T", "rationale": "R", "category": "weird"},'
        ' {"id": "c", "title": "T", "rationale": "R"}]\n'
        '```'
    )
    items = extract_plan(report)
    assert [i["category"] for i in items] == ["gbp", "other", None]


def test_extract_plan_start_after_days_to_scheduled_start():
    from datetime import datetime, timedelta, timezone

    from app.plan_parser import extract_plan

    report = (
        '```json\n'
        '[{"id": "a", "title": "T", "rationale": "R", "start_after_days": 3},'
        ' {"id": "b", "title": "T", "rationale": "R", "start_after_days": 0},'
        ' {"id": "c", "title": "T", "rationale": "R"},'
        ' {"id": "d", "title": "T", "rationale": "R", "start_after_days": "soon"}]\n'
        '```'
    )
    items = extract_plan(report)
    a = datetime.fromisoformat(items[0]["scheduled_start"])
    assert abs((a - (datetime.now(timezone.utc) + timedelta(days=3))).total_seconds()) < 60
    b = datetime.fromisoformat(items[1]["scheduled_start"])
    assert abs((b - datetime.now(timezone.utc)).total_seconds()) < 60
    assert items[2]["scheduled_start"] is None
    assert items[3]["scheduled_start"] is None


def test_legacy_plan_materialization_with_schedule_is_disabled(client):
    import pytest

    from app.db import connect
    from app.plan_parser import create_tasks_from_plan, extract_plan

    report = '```json\n[{"id": "a", "title": "T", "rationale": "R", "start_after_days": 1}]\n```'
    m = client.post(
        "/api/merchants",
        json={"name": "M", "primary_location": "New York, NY"},
    ).json()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
            " VALUES (?, 'core-ss', 'running', 'manual', '2026-09-01T00:00:00+00:00')",
            (m["id"],),
        )
        run_id = conn.execute("SELECT id FROM runs WHERE coreai_run_id = 'core-ss'").fetchone()["id"]
        with pytest.raises(
            RuntimeError,
            match="legacy Plan materialization is disabled; use strict Plan persistence and approval",
        ):
            create_tasks_from_plan(conn, m["id"], run_id, "core-ss", extract_plan(report))
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
    finally:
        conn.rollback()
        conn.close()
