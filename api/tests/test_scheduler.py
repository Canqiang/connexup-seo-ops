from datetime import datetime, timedelta, timezone

from helpers import FakeCoreAi, cleanup_override, override_coreai

REPORT_WITH_PLAN = '报告\n```json\n[{"id": "i1", "title": "T1", "rationale": "R1"}]\n```\n'


def iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def make_merchant_with_run(client, fake, name="M"):
    m = client.post("/api/merchants", json={"name": name}).json()
    override_coreai(fake)
    try:
        run = client.post(f"/api/merchants/{m['id']}/runs").json()
    finally:
        cleanup_override()
    return m, run


def test_poll_marks_succeeded_and_creates_tasks(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": REPORT_WITH_PLAN}

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["report_text"] == REPORT_WITH_PLAN
    assert detail["finished_at"] is not None
    tasks = client.get(f"/api/merchants/{m['id']}/tasks").json()
    assert [t["title"] for t in tasks] == ["T1"]
    assert tasks[0]["source_run_id"] == run["id"]

    poll_runs_once(fake)  # 再跑一轮：终态 run 不再轮询，任务不重复
    assert len(client.get(f"/api/merchants/{m['id']}/tasks").json()) == 1


def test_poll_completed_without_plan_block_still_succeeds(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": "纯文本报告，没有 JSON 块"}

    poll_runs_once(fake)

    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "succeeded"
    assert client.get(f"/api/merchants/{m['id']}/tasks").json() == []


def test_poll_marks_failed_on_terminal_failure(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "TIMEOUT", "error": "took too long"}

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "failed"
    assert "took too long" in detail["error"]


def test_poll_leaves_nonterminal_running(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "RUNNING"}

    poll_runs_once(fake)

    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "running"


def test_auto_scan_triggers_due_merchants_only(client):
    from app.db import connect
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    due = client.post("/api/merchants", json={"name": "due"}).json()
    client.patch(f"/api/merchants/{due['id']}", json={"auto_run_interval_days": 7})
    fresh = client.post("/api/merchants", json={"name": "fresh"}).json()
    client.patch(f"/api/merchants/{fresh['id']}", json={"auto_run_interval_days": 7})
    off = client.post("/api/merchants", json={"name": "off"}).json()
    archived = client.post("/api/merchants", json={"name": "arch"}).json()
    client.patch(f"/api/merchants/{archived['id']}", json={"auto_run_interval_days": 1})
    client.patch(f"/api/merchants/{archived['id']}", json={"status": "archived"})

    conn = connect()
    try:
        # due：上次 run 8 天前结束；fresh：昨天结束
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'old-1', 'succeeded', 'manual', ?, ?)",
            (due["id"], iso_days_ago(8.1), iso_days_ago(8)),
        )
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'old-2', 'succeeded', 'manual', ?, ?)",
            (fresh["id"], iso_days_ago(1.1), iso_days_ago(1)),
        )
        conn.commit()
    finally:
        conn.close()

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == 1  # 只有 due
    runs = client.get(f"/api/merchants/{due['id']}/runs").json()
    assert runs[0]["trigger_kind"] == "auto"
    assert runs[0]["status"] == "running"
    assert client.get(f"/api/merchants/{fresh['id']}/runs").json()[0]["coreai_run_id"] == "old-2"
    assert client.get(f"/api/merchants/{off['id']}/runs").json() == []


def test_auto_scan_first_run_when_never_ran(client):
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    m = client.post("/api/merchants", json={"name": "never"}).json()
    client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 30})

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == 1


def test_auto_scan_skips_merchant_with_running_run(client):
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    m, _run = make_merchant_with_run(client, fake)
    client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 1})
    before = len(fake.triggered)

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == before
