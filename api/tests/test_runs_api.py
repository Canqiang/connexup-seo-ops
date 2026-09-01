from helpers import FakeCoreAi, cleanup_override, override_coreai


def insert_run(client, *, status: str, with_task: bool = False) -> tuple[int, int]:
    import os
    import sqlite3

    merchant = client.post("/api/merchants", json={"name": f"plan-{status}"}).json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
        " VALUES (?, ?, ?, 'manual', '2026-09-01T00:00:00+00:00', ?)",
        (
            merchant["id"],
            f"plan-{status}-{merchant['id']}",
            status,
            "2026-09-01T00:01:00+00:00" if status != "running" else None,
        ),
    )
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    if with_task:
        conn.execute(
            "INSERT INTO tasks (merchant_id, title, source_run_id, source_key, created_at)"
            " VALUES (?, '候选任务', ?, ?, '2026-09-01T00:01:00+00:00')",
            (merchant["id"], run_id, f"plan-test-{run_id}"),
        )
    conn.commit()
    conn.close()
    return merchant["id"], run_id


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


def test_create_run_sends_us_local_diagnosis_context_and_plan_contract(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={
                "name": "Only Bear Chicken & Boba",
                "primary_location": "Mineola, NY",
                "website_url": "https://onlybear.example.com",
                "notes": "restaurant",
            },
        ).json()

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 201
        _agent_id, input_text = fake.triggered[0]
        assert "Only Bear Chicken & Boba" in input_text
        assert "Mineola, NY" in input_text
        assert "https://onlybear.example.com" in input_text
        assert "United States local SEO" in input_text
        assert "English keywords" in input_text
        assert "start_after_days" in input_text
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


def test_approve_plan_rejects_non_succeeded_run(client):
    _merchant_id, running_id = insert_run(client, status="running", with_task=True)
    _merchant_id, failed_id = insert_run(client, status="failed", with_task=True)

    assert client.post(f"/api/runs/{running_id}/approve-plan").status_code == 409
    assert client.post(f"/api/runs/{failed_id}/approve-plan").status_code == 409


def test_approve_plan_rejects_succeeded_run_without_generated_tasks(client):
    _merchant_id, run_id = insert_run(client, status="succeeded")

    response = client.post(f"/api/runs/{run_id}/approve-plan")

    assert response.status_code == 409
    assert response.json()["detail"] == "run has no generated plan"


def test_approve_plan_is_persisted_and_idempotent(client):
    _merchant_id, run_id = insert_run(client, status="succeeded", with_task=True)

    first = client.post(f"/api/runs/{run_id}/approve-plan")
    second = client.post(f"/api/runs/{run_id}/approve-plan")

    assert first.status_code == 200
    assert first.json()["plan_approved_at"] is not None
    assert second.status_code == 200
    assert second.json()["plan_approved_at"] == first.json()["plan_approved_at"]
    assert client.get(f"/api/runs/{run_id}").json()["plan_approved_at"] == first.json()["plan_approved_at"]
