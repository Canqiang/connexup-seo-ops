from helpers import FakeCoreAi, cleanup_override, override_coreai


def test_create_run_triggers_and_stores(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post("/api/merchants", json={"name": "Alpha", "notes": "n"}).json()
        res = client.post(f"/api/merchants/{m['id']}/runs")
        assert res.status_code == 201
        run = res.json()
        assert run["status"] == "running"
        assert run["trigger_kind"] == "manual"
        assert run["coreai_run_id"] == "core-1"
        agent_id, input_text = fake.triggered[0]
        assert agent_id == "agent-t"
        assert "Alpha" in input_text
    finally:
        cleanup_override()


def test_create_run_conflict_when_running(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post("/api/merchants", json={"name": "M"}).json()
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 201
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 409
    finally:
        cleanup_override()


def test_create_run_503_when_unconfigured(client):
    m = client.post("/api/merchants", json={"name": "M"}).json()
    assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 503


def test_create_run_404_missing_merchant(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        assert client.post("/api/merchants/999/runs").status_code == 404
    finally:
        cleanup_override()


def test_trigger_failure_stores_failed_run(client):
    override_coreai(FakeCoreAi(fail=True))
    try:
        m = client.post("/api/merchants", json={"name": "M"}).json()
        res = client.post(f"/api/merchants/{m['id']}/runs")
        assert res.status_code == 201
        run = res.json()
        assert run["status"] == "failed"
        assert "core-ai down" in run["error"]
        assert run["finished_at"] is not None
        # 失败 run 不算进行中，可再次发起
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 201
    finally:
        cleanup_override()


def test_list_and_get_runs(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post("/api/merchants", json={"name": "M"}).json()
        run = client.post(f"/api/merchants/{m['id']}/runs").json()
        listed = client.get(f"/api/merchants/{m['id']}/runs").json()
        assert [r["id"] for r in listed] == [run["id"]]
        assert "report_text" not in listed[0]
        detail = client.get(f"/api/runs/{run['id']}").json()
        assert detail["id"] == run["id"]
        assert "report_text" in detail
        assert client.get("/api/runs/999").status_code == 404
        assert client.get("/api/merchants/999/runs").status_code == 404
    finally:
        cleanup_override()


def test_patch_merchant_interval(client):
    m = client.post("/api/merchants", json={"name": "M"}).json()
    assert m["auto_run_interval_days"] is None
    res = client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 7})
    assert res.json()["auto_run_interval_days"] == 7
    res = client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": None})
    assert res.json()["auto_run_interval_days"] is None
    assert client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 0}).status_code == 422


def test_run_tasks_endpoint(client):
    import os
    import sqlite3

    m = client.post("/api/merchants", json={"name": "M"}).json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
        " VALUES (?, 'rt1', 'succeeded', 'manual', '2026-09-01T00:00:00+00:00')",
        (m["id"],),
    )
    run_id = conn.execute("SELECT id FROM runs WHERE coreai_run_id='rt1'").fetchone()[0]
    conn.execute(
        "INSERT INTO tasks (merchant_id, title, source_run_id, source_key, created_at)"
        " VALUES (?, 'from-run', ?, 'plan-rt1-a', '2026-09-01T00:06:00+00:00')",
        (m["id"], run_id),
    )
    conn.commit()
    conn.close()
    client.post(f"/api/merchants/{m['id']}/tasks", json={"title": "manual"})

    tasks = client.get(f"/api/runs/{run_id}/tasks").json()
    assert [t["title"] for t in tasks] == ["from-run"]
    assert client.get("/api/runs/999/tasks").status_code == 404
