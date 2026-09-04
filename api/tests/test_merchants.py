import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest


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


def test_create_archive_duplicate_archive_and_restore_append_status_history(client):
    created = client.post(
        "/api/merchants",
        json={"name": "Lifecycle", "primary_location": "Mineola, NY"},
    ).json()
    merchant_id = created["id"]

    assert (
        client.patch(
            f"/api/merchants/{merchant_id}", json={"status": "archived"}
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/merchants/{merchant_id}", json={"status": "archived"}
        ).status_code
        == 409
    )
    assert (
        client.patch(
            f"/api/merchants/{merchant_id}", json={"status": "active"}
        ).status_code
        == 200
    )

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    from app.migrations import register_sqlite_invariants

    register_sqlite_invariants(conn)
    rows = conn.execute(
        "SELECT status,generation,actor,reason,effective_at,created_at,content_sha256 "
        "FROM merchant_status_events WHERE merchant_id=? ORDER BY generation",
        (merchant_id,),
    ).fetchall()
    valid_hashes = [
        conn.execute(
            "SELECT content_sha256(?,?,?,?,?,?)",
            (merchant_id, status, effective_at, generation, actor, reason),
        ).fetchone()[0]
        for status, generation, actor, reason, effective_at, _created_at, _hash in rows
    ]
    conn.close()

    assert [(row[0], row[1], row[2], row[3]) for row in rows] == [
        ("active", 1, "test", "merchant_created"),
        ("archived", 2, "test", "merchant_archived"),
        ("active", 3, "test", "merchant_restored"),
    ]
    assert all(row[4].endswith("Z") and len(row[4]) == 27 for row in rows)
    assert all(row[5] == row[4] for row in rows)
    assert [row[6] for row in rows] == valid_hashes


def test_concurrent_duplicate_archive_appends_exactly_one_generation(client):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Archive once", "primary_location": "Mineola, NY"},
    ).json()

    def archive_once(_index):
        response = client.patch(
            f"/api/merchants/{merchant['id']}", json={"status": "archived"}
        )
        return response.status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(archive_once, range(2)))

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    events = conn.execute(
        "SELECT status,generation FROM merchant_status_events "
        "WHERE merchant_id=? ORDER BY generation",
        (merchant["id"],),
    ).fetchall()
    conn.close()

    assert sorted(results) == [200, 409]
    assert events == [("active", 1), ("archived", 2)]


def test_create_rolls_back_merchant_when_initial_status_event_fails(client):
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "CREATE TRIGGER reject_lifecycle_test BEFORE INSERT ON merchant_status_events "
        "WHEN NEW.reason='merchant_created' BEGIN "
        "SELECT RAISE(ABORT, 'reject lifecycle test'); END"
    )
    conn.commit()
    conn.close()

    with pytest.raises(sqlite3.IntegrityError, match="reject lifecycle test"):
        client.post(
            "/api/merchants",
            json={"name": "Must rollback", "primary_location": "Mineola, NY"},
        )

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    count = conn.execute(
        "SELECT count(*) FROM merchants WHERE name='Must rollback'"
    ).fetchone()[0]
    conn.close()
    assert count == 0


def test_archive_rolls_back_status_and_other_fields_when_event_insert_fails(client):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Keep original", "primary_location": "Mineola, NY"},
    ).json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "CREATE TRIGGER reject_archive_event_test "
        "BEFORE INSERT ON merchant_status_events "
        "WHEN NEW.reason='merchant_archived' BEGIN "
        "SELECT RAISE(ABORT, 'reject archive event test'); END"
    )
    conn.commit()
    conn.close()

    with pytest.raises(sqlite3.IntegrityError, match="reject archive event test"):
        client.patch(
            f"/api/merchants/{merchant['id']}",
            json={"name": "Must rollback", "status": "archived"},
        )

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    row = conn.execute(
        "SELECT name,status FROM merchants WHERE id=?", (merchant["id"],)
    ).fetchone()
    events = conn.execute(
        "SELECT status,generation FROM merchant_status_events WHERE merchant_id=?",
        (merchant["id"],),
    ).fetchall()
    conn.close()
    assert row == ("Keep original", "active")
    assert events == [("active", 1)]


def test_create_merchant_rejects_empty_name(client):
    assert (
        client.post(
            "/api/merchants",
            json={"name": "", "primary_location": "Mineola, NY"},
        ).status_code
        == 422
    )


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
        assert any(
            error["loc"] == ["body", field] for error in response.json()["detail"]
        )


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
    assert [
        m["id"]
        for m in client.get("/api/merchants", params={"status": "active"}).json()
    ] == [a["id"]]
    assert [
        m["id"]
        for m in client.get("/api/merchants", params={"status": "archived"}).json()
    ] == [b["id"]]
    assert len(client.get("/api/merchants").json()) == 2


def test_patch_merchant_fields(client):
    m = client.post(
        "/api/merchants", json={"name": "Old", "primary_location": "Mineola, NY"}
    ).json()
    res = client.patch(f"/api/merchants/{m['id']}", json={"name": "New", "notes": "n2"})
    assert res.status_code == 200
    assert res.json()["name"] == "New"
    assert res.json()["notes"] == "n2"


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "must not change"},
        {"notes": "must not change"},
        {"auto_run_interval_days": 7},
        {"status": "archived", "website_url": "https://must-not-change.test"},
        {"status": "active", "name": "restore plus mutation is forbidden"},
    ],
)
def test_archived_merchant_patch_only_allows_exact_restore(client, payload):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Frozen", "primary_location": "Mineola, NY"},
    ).json()
    assert (
        client.patch(
            f"/api/merchants/{merchant['id']}", json={"status": "archived"}
        ).status_code
        == 200
    )

    response = client.patch(f"/api/merchants/{merchant['id']}", json=payload)

    assert response.status_code == 409
    persisted = client.get(f"/api/merchants/{merchant['id']}").json()
    assert persisted["status"] == "archived"
    assert persisted["name"] == "Frozen"
    assert persisted["notes"] is None
    assert persisted["website_url"] is None
    assert persisted["auto_run_interval_days"] is None


def test_archived_merchant_patch_allows_exact_restore(client):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Restorable", "primary_location": "Mineola, NY"},
    ).json()
    assert (
        client.patch(
            f"/api/merchants/{merchant['id']}", json={"status": "archived"}
        ).status_code
        == 200
    )

    restored = client.patch(
        f"/api/merchants/{merchant['id']}", json={"status": "active"}
    )

    assert restored.status_code == 200
    assert restored.json()["status"] == "active"


def test_patch_merchant_rejects_bad_status(client):
    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "Mineola, NY"}
    ).json()
    assert (
        client.patch(f"/api/merchants/{m['id']}", json={"status": "frozen"}).status_code
        == 422
    )


def test_patch_merchant_rejects_explicit_null_on_required_fields(client):
    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "Mineola, NY"}
    ).json()
    assert (
        client.patch(f"/api/merchants/{m['id']}", json={"name": None}).status_code
        == 422
    )
    assert (
        client.patch(f"/api/merchants/{m['id']}", json={"status": None}).status_code
        == 422
    )


def test_patch_missing_merchant_404(client):
    assert client.patch("/api/merchants/999", json={"name": "X"}).status_code == 404


def test_delete_merchant_method_is_exposed_in_openapi(client):
    schema = client.get("/openapi.json").json()

    assert "delete" in schema["paths"]["/api/merchants/{merchant_id}"]


def test_delete_archived_blank_draft_removes_only_merchant_and_draft_lifecycle(client):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Mistaken draft", "primary_location": "Mineola, NY"},
    ).json()
    merchant_id = merchant["id"]
    assert (
        client.patch(
            f"/api/merchants/{merchant_id}", json={"status": "archived"}
        ).status_code
        == 200
    )

    listed = client.get("/api/merchants", params={"status": "archived"}).json()
    assert next(row for row in listed if row["id"] == merchant_id)["can_delete"] is True

    response = client.delete(f"/api/merchants/{merchant_id}")

    assert response.status_code == 204
    assert client.get(f"/api/merchants/{merchant_id}").status_code == 404
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    try:
        assert (
            conn.execute(
                "SELECT count(*) FROM merchant_status_events WHERE merchant_id=?",
                (merchant_id,),
            ).fetchone()[0]
            == 0
        )
    finally:
        conn.close()


def test_delete_active_blank_draft_requires_archive_first(client):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Active draft", "primary_location": "Mineola, NY"},
    ).json()

    response = client.delete(f"/api/merchants/{merchant['id']}")

    assert response.status_code == 409
    assert response.json()["detail"] == "merchant must be archived before deletion"
    assert client.get(f"/api/merchants/{merchant['id']}").status_code == 200


def test_delete_request_rejects_durable_history_and_preserves_archived_merchant_data(
    client,
):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Preserved", "primary_location": "Mineola, NY"},
    ).json()
    merchant_id = merchant["id"]
    assert (
        client.put(
            f"/api/merchants/{merchant_id}/fbr-link",
            json={"fbr_merchant_id": "fbr-preserved"},
        ).status_code
        == 200
    )
    task = client.post(
        f"/api/merchants/{merchant_id}/tasks",
        json={
            "task_type": "PREPARE_ONLY",
            "title": "Preserved task",
            "rationale": "Historical work must remain available",
            "expected_outcome": "Archived merchant history remains readable",
            "parameters": {},
        },
    )
    assert task.status_code == 201
    assert (
        client.patch(
            f"/api/merchants/{merchant_id}", json={"status": "archived"}
        ).status_code
        == 200
    )

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    objects = conn.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    before = {
        name: conn.execute(
            f'SELECT * FROM "{name.replace(chr(34), chr(34) * 2)}"'
        ).fetchall()
        for (name,) in objects
    }
    assert (
        conn.execute(
            "SELECT count(*) FROM merchant_fbr_binding_events WHERE merchant_id=?",
            (merchant_id,),
        ).fetchone()[0]
        == 1
    )
    assert (
        conn.execute(
            "SELECT count(*) FROM tasks WHERE merchant_id=?", (merchant_id,)
        ).fetchone()[0]
        == 1
    )
    conn.close()

    response = client.delete(f"/api/merchants/{merchant_id}")

    assert response.status_code == 409
    assert (
        response.json()["detail"] == "merchant has durable history; archive it instead"
    )
    assert client.get(f"/api/merchants/{merchant_id}").json()["status"] == "archived"
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    after = {
        name: conn.execute(
            f'SELECT * FROM "{name.replace(chr(34), chr(34) * 2)}"'
        ).fetchall()
        for (name,) in objects
    }
    conn.close()
    assert after == before


def test_archived_merchant_with_durable_history_is_not_marked_deletable(client):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Durable", "primary_location": "Mineola, NY"},
    ).json()
    assert (
        client.put(
            f"/api/merchants/{merchant['id']}/fbr-link",
            json={"fbr_merchant_id": "durable-fbr"},
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/merchants/{merchant['id']}", json={"status": "archived"}
        ).status_code
        == 200
    )

    listed = client.get("/api/merchants", params={"status": "archived"}).json()

    assert (
        next(row for row in listed if row["id"] == merchant["id"])["can_delete"]
        is False
    )


def test_archived_merchant_with_restore_history_is_not_a_deletable_blank_draft(client):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Restored once", "primary_location": "Mineola, NY"},
    ).json()
    for status in ("archived", "active", "archived"):
        assert (
            client.patch(
                f"/api/merchants/{merchant['id']}", json={"status": status}
            ).status_code
            == 200
        )

    listed = client.get("/api/merchants", params={"status": "archived"}).json()
    assert (
        next(row for row in listed if row["id"] == merchant["id"])["can_delete"]
        is False
    )

    response = client.delete(f"/api/merchants/{merchant['id']}")

    assert response.status_code == 409
    assert response.json() == {
        "detail": "merchant has durable history; archive it instead"
    }
    assert client.get(f"/api/merchants/{merchant['id']}").status_code == 200


def test_plan_only_history_is_not_deletable_and_has_database_guard(client):
    from app.db import connect

    merchant = client.post(
        "/api/merchants",
        json={"name": "Plan history", "primary_location": "Mineola, NY"},
    ).json()
    assert (
        client.patch(
            f"/api/merchants/{merchant['id']}", json={"status": "archived"}
        ).status_code
        == 200
    )
    conn = connect()
    conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id,source_kind,state,latest_revision,created_at) "
        "VALUES (?,'OPERATOR','CLOSED',1,'2026-09-04T00:00:00.000000Z')",
        (merchant["id"],),
    )
    conn.commit()

    listed = client.get("/api/merchants", params={"status": "archived"}).json()
    assert (
        next(row for row in listed if row["id"] == merchant["id"])["can_delete"]
        is False
    )
    response = client.delete(f"/api/merchants/{merchant['id']}")
    assert response.status_code == 409
    assert response.json() == {
        "detail": "merchant has durable history; archive it instead"
    }

    with pytest.raises(sqlite3.IntegrityError, match="merchant_has_durable_history"):
        conn.execute("DELETE FROM merchants WHERE id=?", (merchant["id"],))
    conn.rollback()
    assert conn.execute(
        "SELECT count(*) FROM task_plans WHERE merchant_id=?", (merchant["id"],)
    ).fetchone()[0] == 1
    conn.close()


def test_rejected_relink_command_is_durable_history_and_has_database_guard(client):
    from app.db import connect

    merchant = client.post(
        "/api/merchants",
        json={"name": "Command history", "primary_location": "Mineola, NY"},
    ).json()
    assert (
        client.patch(
            f"/api/merchants/{merchant['id']}", json={"status": "archived"}
        ).status_code
        == 200
    )

    rejected = client.post(
        "/api/performance-identities/fbr/relink",
        json={
            "request_id": "archived-relink-command",
            "merchant_id": merchant["id"],
            "expected_current_binding_generation": 1,
            "expected_current_fbr_sha256": "a" * 64,
            "new_fbr_merchant_id": "fbr-never-bound",
            "reason": "Rejected command remains auditable",
            "confirmed": True,
        },
    )
    assert rejected.status_code == 409
    assert rejected.json() == {"detail": "merchant is archived"}

    listed = client.get("/api/merchants", params={"status": "archived"}).json()
    assert (
        next(row for row in listed if row["id"] == merchant["id"])["can_delete"]
        is False
    )
    response = client.delete(f"/api/merchants/{merchant['id']}")
    assert response.status_code == 409
    assert response.json() == {
        "detail": "merchant has durable history; archive it instead"
    }

    conn = connect()
    try:
        ledger = conn.execute(
            "SELECT command_kind,target_kind,target_stable_id,http_status "
            "FROM operator_command_ledger WHERE request_id=?",
            ("archived-relink-command",),
        ).fetchone()
        assert tuple(ledger) == (
            "FBR_RELINK",
            "MERCHANT",
            str(merchant["id"]),
            409,
        )
        with pytest.raises(
            sqlite3.IntegrityError, match="merchant_has_durable_history"
        ):
            conn.execute("DELETE FROM merchants WHERE id=?", (merchant["id"],))
        conn.rollback()
        assert conn.execute(
            "SELECT count(*) FROM merchants WHERE id=?", (merchant["id"],)
        ).fetchone()[0] == 1
    finally:
        conn.close()


def test_missing_relink_command_does_not_poison_a_future_merchant_id(client):
    missing = client.post(
        "/api/performance-identities/fbr/relink",
        json={
            "request_id": "missing-relink-command",
            "merchant_id": 1,
            "expected_current_binding_generation": 1,
            "expected_current_fbr_sha256": "a" * 64,
            "new_fbr_merchant_id": "fbr-missing",
            "reason": "The target does not exist yet",
            "confirmed": True,
        },
    )
    assert missing.status_code == 404
    assert missing.json() == {"detail": "merchant not found"}

    merchant = client.post(
        "/api/merchants",
        json={"name": "Later draft", "primary_location": "Mineola, NY"},
    ).json()
    assert merchant["id"] == 1
    assert (
        client.patch(
            f"/api/merchants/{merchant['id']}", json={"status": "archived"}
        ).status_code
        == 200
    )

    listed = client.get("/api/merchants", params={"status": "archived"}).json()
    assert (
        next(row for row in listed if row["id"] == merchant["id"])["can_delete"]
        is True
    )
    assert client.delete(f"/api/merchants/{merchant['id']}").status_code == 204

    from app.db import connect

    conn = connect()
    try:
        assert conn.execute(
            "SELECT http_status FROM operator_command_ledger WHERE request_id=?",
            ("missing-relink-command",),
        ).fetchone()[0] == 404
        assert conn.execute(
            "SELECT count(*) FROM merchants WHERE id=?", (merchant["id"],)
        ).fetchone()[0] == 0
    finally:
        conn.close()


def test_list_merchants_includes_work_stats(client):
    import os
    import sqlite3

    m = client.post(
        "/api/merchants",
        json={"name": "S", "primary_location": "Mineola, NY"},
    ).json()

    def create(title):
        response = client.post(
            f"/api/merchants/{m['id']}/tasks",
            json={
                "task_type": "PREPARE_ONLY",
                "title": title,
                "rationale": "Work is required",
                "expected_outcome": "Reviewable work",
                "parameters": {},
            },
        )
        assert response.status_code == 201
        return response.json()

    create("a")
    create("b")
    preparing = create("c")
    executing = create("d")
    verifying = create("e")
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "UPDATE tasks SET status = 'PREPARING' WHERE id = ?", (preparing["id"],)
    )
    conn.execute(
        "UPDATE tasks SET status = 'EXECUTING' WHERE id = ?", (executing["id"],)
    )
    conn.execute(
        "UPDATE tasks SET status = 'VERIFYING' WHERE id = ?", (verifying["id"],)
    )
    conn.execute(
        "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
        " VALUES (?, 'r1', 'succeeded', 'manual', '2026-09-01T00:00:00+00:00', '2026-09-01T00:05:00+00:00')",
        (m["id"],),
    )
    conn.commit()
    conn.close()

    row = [x for x in client.get("/api/merchants").json() if x["id"] == m["id"]][0]
    assert row["todo_count"] == 2
    assert row["doing_count"] == 3
    assert row["has_running_run"] is False
    assert row["last_run_status"] == "succeeded"
    assert row["last_run_at"] == "2026-09-01T00:00:00+00:00"
