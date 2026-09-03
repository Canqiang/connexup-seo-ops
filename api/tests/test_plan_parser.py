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


def test_create_tasks_idempotent(client):
    """通过 client fixture 拿到已初始化的库；直接用底层连接验证幂等。"""
    from app.db import connect
    from app.plan_parser import create_tasks_from_plan, extract_plan

    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "Mineola, NY"}
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
        assert create_tasks_from_plan(conn, m["id"], run_id, "core-r1", items) == 2
        assert create_tasks_from_plan(conn, m["id"], run_id, "core-r1", items) == 0  # 幂等
        conn.commit()
    finally:
        conn.close()

    tasks = client.get(f"/api/merchants/{m['id']}/tasks").json()
    assert len(tasks) == 2
    by_key = {t["source_key"]: t for t in tasks}
    assert set(by_key) == {"plan-core-r1-item-1", "plan-core-r1-item-2"}
    t1 = by_key["plan-core-r1-item-1"]
    assert t1["status"] == "todo"
    assert t1["rationale"] == "营业时间与官网不一致"
    assert t1["source_run_id"] == run_id


def test_extract_plan_carries_expected_outcome(client):
    from app.db import connect
    from app.plan_parser import create_tasks_from_plan, extract_plan

    report = (
        '```json\n'
        '[{"id": "a", "title": "T", "rationale": "R", "expected_outcome": "E"},'
        ' {"id": "b", "title": "T2", "rationale": "R2"}]\n'
        '```'
    )
    items = extract_plan(report)
    assert items[0]["expected_outcome"] == "E"
    assert items[1]["expected_outcome"] is None

    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "Mineola, NY"}
    ).json()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
            " VALUES (?, 'core-eo', 'running', 'manual', '2026-09-01T00:00:00+00:00')",
            (m["id"],),
        )
        run_id = conn.execute("SELECT id FROM runs WHERE coreai_run_id = 'core-eo'").fetchone()["id"]
        create_tasks_from_plan(conn, m["id"], run_id, "core-eo", items)
        conn.commit()
    finally:
        conn.close()
    by_key = {t["source_key"]: t for t in client.get(f"/api/merchants/{m['id']}/tasks").json()}
    assert by_key["plan-core-eo-a"]["expected_outcome"] == "E"
    assert by_key["plan-core-eo-b"]["expected_outcome"] is None


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


def test_create_tasks_persists_scheduled_start(client):
    from app.db import connect
    from app.plan_parser import create_tasks_from_plan, extract_plan

    report = '```json\n[{"id": "a", "title": "T", "rationale": "R", "start_after_days": 1}]\n```'
    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "Mineola, NY"}
    ).json()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
            " VALUES (?, 'core-ss', 'running', 'manual', '2026-09-01T00:00:00+00:00')",
            (m["id"],),
        )
        run_id = conn.execute("SELECT id FROM runs WHERE coreai_run_id = 'core-ss'").fetchone()["id"]
        create_tasks_from_plan(conn, m["id"], run_id, "core-ss", extract_plan(report))
        conn.commit()
    finally:
        conn.close()
    t = client.get(f"/api/merchants/{m['id']}/tasks").json()[0]
    assert t["scheduled_start"] is not None
