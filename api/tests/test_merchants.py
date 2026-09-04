import os
import sqlite3


def test_create_and_get_merchant(client):
    res = client.post(
        "/api/merchants",
        json={"name": "Alpha", "notes": "first", "primary_location": "Mineola, NY"},
    )
    assert res.status_code == 201
    m = res.json()
    assert m["name"] == "Alpha"
    assert m["status"] == "active"
    assert m["notes"] == "first"
    assert m["created_at"]
    assert client.get(f"/api/merchants/{m['id']}").json()["name"] == "Alpha"


def test_create_merchant_rejects_empty_name(client):
    assert client.post(
        "/api/merchants",
        json={"name": "", "primary_location": "Mineola, NY"},
    ).status_code == 422


def test_create_merchant_requires_primary_location(client):
    response = client.post("/api/merchants", json={"name": "Alpha"})

    assert response.status_code == 422
    assert any(
        error["loc"] == ["body", "primary_location"] and error["type"] == "missing"
        for error in response.json()["detail"]
    )


def test_create_merchant_rejects_required_fields_that_are_blank_after_trimming(client):
    blank_name = client.post(
        "/api/merchants",
        json={"name": "   ", "primary_location": "Mineola, NY"},
    )
    blank_location = client.post(
        "/api/merchants",
        json={"name": "Alpha", "primary_location": " \n\t "},
    )

    assert blank_name.status_code == 422
    assert blank_name.json()["detail"][0]["loc"] == ["body", "name"]
    assert blank_location.status_code == 422
    assert blank_location.json()["detail"][0]["loc"] == ["body", "primary_location"]


def test_create_merchant_trims_required_fields_and_allows_website_to_be_omitted(client):
    response = client.post(
        "/api/merchants",
        json={"name": "  Alpha  ", "primary_location": "  Mineola, NY  "},
    )

    assert response.status_code == 201
    assert response.json()["name"] == "Alpha"
    assert response.json()["primary_location"] == "Mineola, NY"
    assert response.json()["website_url"] is None


def test_create_merchant_rejects_oversized_public_profile_fields(client):
    cases = (
        ("name", "n" * 201),
        ("primary_location", "l" * 501),
        ("website_url", "https://example.com/" + "w" * 2030),
    )

    for field, value in cases:
        payload = {"name": "Alpha", "primary_location": "Mineola, NY", field: value}
        response = client.post("/api/merchants", json=payload)

        assert response.status_code == 422
        assert any(error["loc"] == ["body", field] for error in response.json()["detail"])


def test_create_and_patch_merchant_preserves_public_diagnosis_inputs(client):
    created = client.post(
        "/api/merchants",
        json={
            "name": "Only Bear Chicken & Boba",
            "primary_location": "Mineola, NY",
            "website_url": "https://onlybear.example.com",
        },
    )

    assert created.status_code == 201
    assert created.json()["primary_location"] == "Mineola, NY"
    assert created.json()["website_url"] == "https://onlybear.example.com"

    merchant_id = created.json()["id"]
    updated = client.patch(
        f"/api/merchants/{merchant_id}",
        json={
            "primary_location": "Garden City, NY",
            "website_url": "https://onlybear.example.com/mineola",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["primary_location"] == "Garden City, NY"
    assert updated.json()["website_url"] == "https://onlybear.example.com/mineola"


def test_get_missing_merchant_404(client):
    assert client.get("/api/merchants/999").status_code == 404


def test_list_merchants_filter_by_status(client):
    a = client.post(
        "/api/merchants", json={"name": "A", "primary_location": "Mineola, NY"}
    ).json()
    b = client.post(
        "/api/merchants", json={"name": "B", "primary_location": "Mineola, NY"}
    ).json()
    client.patch(f"/api/merchants/{b['id']}", json={"status": "archived"})
    assert [m["id"] for m in client.get("/api/merchants", params={"status": "active"}).json()] == [a["id"]]
    assert [m["id"] for m in client.get("/api/merchants", params={"status": "archived"}).json()] == [b["id"]]
    assert len(client.get("/api/merchants").json()) == 2


def test_patch_merchant_fields(client):
    m = client.post(
        "/api/merchants", json={"name": "Old", "primary_location": "Mineola, NY"}
    ).json()
    res = client.patch(f"/api/merchants/{m['id']}", json={"name": "New", "notes": "n2"})
    assert res.status_code == 200
    assert res.json()["name"] == "New"
    assert res.json()["notes"] == "n2"


def test_patch_merchant_rejects_bad_status(client):
    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "Mineola, NY"}
    ).json()
    assert client.patch(f"/api/merchants/{m['id']}", json={"status": "frozen"}).status_code == 422


def test_patch_merchant_rejects_explicit_null_on_required_fields(client):
    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "Mineola, NY"}
    ).json()
    assert client.patch(f"/api/merchants/{m['id']}", json={"name": None}).status_code == 422
    assert client.patch(f"/api/merchants/{m['id']}", json={"status": None}).status_code == 422


def test_patch_and_delete_missing_merchant_404(client):
    assert client.patch("/api/merchants/999", json={"name": "X"}).status_code == 404
    assert client.delete("/api/merchants/999").status_code == 404


def test_delete_requires_an_archived_merchant_without_related_records(client):
    m = client.post(
        "/api/merchants", json={"name": "Gone", "primary_location": "Mineola, NY"}
    ).json()

    active_delete = client.delete(f"/api/merchants/{m['id']}")

    assert active_delete.status_code == 409
    assert active_delete.json()["detail"] == "archive merchant before deleting it"
    assert client.patch(
        f"/api/merchants/{m['id']}", json={"status": "archived"}
    ).status_code == 200
    assert client.delete(f"/api/merchants/{m['id']}").status_code == 204
    assert client.get(f"/api/merchants/{m['id']}").status_code == 404


def test_delete_archived_merchant_preserves_tasks_and_related_business_data(client):
    m = client.post(
        "/api/merchants",
        json={"name": "Archived with history", "primary_location": "Mineola, NY"},
    ).json()
    assert client.put(
        f"/api/merchants/{m['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-connected"},
    ).status_code == 200
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO runs"
        " (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
        " VALUES (?, 'finished-run', 'succeeded', 'manual', ?, ?)",
        (m["id"], "2026-09-02T00:00:00+00:00", "2026-09-02T00:01:00+00:00"),
    )
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO audit_snapshots"
        " (run_id, merchant_id, schema_version, payload_json, evidence_mode,"
        " finding_count, accepted_at) VALUES (?, ?, 'seo_ops.audit_report.v1', '{}',"
        " 'CONFIRMED_FACTS_ONLY', 1, '2026-09-02T00:01:00+00:00')",
        (run_id, m["id"]),
    )
    conn.execute(
        "INSERT INTO tasks (merchant_id, title, source_run_id, created_at)"
        " VALUES (?, 'historical task', ?, '2026-09-02T00:01:00+00:00')",
        (m["id"], run_id),
    )
    task_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO task_executions (task_id, status, attempt, created_at, finished_at)"
        " VALUES (?, 'failed', 1, '2026-09-02T00:02:00+00:00', '2026-09-02T00:03:00+00:00')",
        (task_id,),
    )
    conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " request_json, payload_json, created_at, completed_at)"
        " VALUES (?, 'cycle-delete', 'KEYWORD_SET', 'v2', 'ready', 'keyword-agent',"
        " '{}', '{}', '2026-09-02T00:00:00+00:00', '2026-09-02T00:01:00+00:00')",
        (m["id"],),
    )
    artifact_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO merchant_local_falcon_approvals"
        " (merchant_id, keyword_artifact_id, cohort_sha256, cohort_json, place_id,"
        " approved_by, approved_at) VALUES (?, ?, ?, '[]', 'place-delete', 'test', ?)",
        (m["id"], artifact_id, "a" * 64, "2026-09-02T00:02:00+00:00"),
    )
    approval_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO merchant_local_falcon_scan_confirmations"
        " (merchant_id, approval_id, confirmation_request_id, scan_config_sha256,"
        " scan_config_json, confirmed_by, confirmed_at) VALUES (?, ?, 'confirm-delete',"
        " ?, '{}', 'test', ?)",
        (m["id"], approval_id, "b" * 64, "2026-09-02T00:03:00+00:00"),
    )
    confirmation_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO merchant_local_falcon_scan_batches"
        " (merchant_id, approval_id, confirmation_id, request_id, status, scan_config_json,"
        " created_at, completed_at) VALUES (?, ?, ?, 'batch-delete', 'completed', '{}', ?, ?)",
        (
            m["id"],
            approval_id,
            confirmation_id,
            "2026-09-02T00:04:00+00:00",
            "2026-09-02T00:05:00+00:00",
        ),
    )
    batch_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO merchant_local_falcon_scan_items"
        " (batch_id, keyword, status, updated_at) VALUES (?, 'breakfast', 'completed', ?)",
        (batch_id, "2026-09-02T00:05:00+00:00"),
    )
    conn.commit()
    conn.close()
    assert client.patch(
        f"/api/merchants/{m['id']}", json={"status": "archived"}
    ).status_code == 200

    response = client.delete(f"/api/merchants/{m['id']}")

    assert response.status_code == 409
    assert response.json()["detail"] == "merchant has durable history; archive preserves it"
    assert client.get(f"/api/merchants/{m['id']}").status_code == 200
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    remaining = {
        "tasks": conn.execute("SELECT COUNT(*) FROM tasks WHERE merchant_id = ?", (m["id"],)).fetchone()[0],
        "task_executions": conn.execute(
            "SELECT COUNT(*) FROM task_executions WHERE task_id = ?", (task_id,)
        ).fetchone()[0],
        "runs": conn.execute("SELECT COUNT(*) FROM runs WHERE merchant_id = ?", (m["id"],)).fetchone()[0],
        "audit_snapshots": conn.execute(
            "SELECT COUNT(*) FROM audit_snapshots WHERE merchant_id = ?", (m["id"],)
        ).fetchone()[0],
        "merchant_fbr_links": conn.execute(
            "SELECT COUNT(*) FROM merchant_fbr_links WHERE merchant_id = ?", (m["id"],)
        ).fetchone()[0],
        "merchant_seo_artifacts": conn.execute(
            "SELECT COUNT(*) FROM merchant_seo_artifacts WHERE merchant_id = ?", (m["id"],)
        ).fetchone()[0],
        "merchant_local_falcon_scan_items": conn.execute(
            "SELECT COUNT(*) FROM merchant_local_falcon_scan_items WHERE batch_id = ?", (batch_id,)
        ).fetchone()[0],
    }
    conn.close()
    assert remaining == {table: 1 for table in remaining}


def test_archive_rejects_merchant_with_active_work(client):
    m = client.post(
        "/api/merchants", json={"name": "Running", "primary_location": "Mineola, NY"}
    ).json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
        " VALUES (?, 'still-running', 'running', 'manual', '2026-09-02T00:00:00+00:00')",
        (m["id"],),
    )
    conn.commit()
    conn.close()

    response = client.patch(f"/api/merchants/{m['id']}", json={"status": "archived"})

    assert response.status_code == 409
    assert response.json()["detail"] == "merchant has active work; resolve it before archiving"
    assert client.get(f"/api/merchants/{m['id']}").json()["status"] == "active"


def test_archive_rejects_merchant_with_agent_execution_awaiting_review(client):
    m = client.post(
        "/api/merchants",
        json={"name": "Awaiting Review", "primary_location": "Mineola, NY"},
    ).json()
    task = client.post(f"/api/merchants/{m['id']}/tasks", json={"title": "Review me"}).json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO task_executions (task_id, status, attempt, created_at)"
        " VALUES (?, 'ready', 1, '2026-09-02T00:00:00+00:00')",
        (task["id"],),
    )
    conn.commit()
    conn.close()

    response = client.patch(f"/api/merchants/{m['id']}", json={"status": "archived"})

    assert response.status_code == 409
    assert response.json()["detail"] == "merchant has active work; resolve it before archiving"
    assert client.get(f"/api/merchants/{m['id']}").json()["status"] == "active"


def test_list_merchants_includes_work_stats(client):
    import os
    import sqlite3

    m = client.post(
        "/api/merchants", json={"name": "S", "primary_location": "Mineola, NY"}
    ).json()
    client.post(f"/api/merchants/{m['id']}/tasks", json={"title": "a"})
    client.post(f"/api/merchants/{m['id']}/tasks", json={"title": "b"})
    t = client.post(f"/api/merchants/{m['id']}/tasks", json={"title": "c"}).json()
    client.patch(f"/api/tasks/{t['id']}", json={"status": "doing"})
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
        " VALUES (?, 'r1', 'succeeded', 'manual', '2026-09-01T00:00:00+00:00', '2026-09-01T00:05:00+00:00')",
        (m["id"],),
    )
    conn.commit()
    conn.close()

    row = [x for x in client.get("/api/merchants").json() if x["id"] == m["id"]][0]
    assert row["todo_count"] == 2
    assert row["doing_count"] == 1
    assert row["has_running_run"] is False
    assert row["last_run_status"] == "succeeded"
    assert row["last_run_at"] == "2026-09-01T00:00:00+00:00"
