import os
import sqlite3


def test_create_and_get_merchant(client):
    res = client.post("/api/merchants", json={"name": "Alpha", "notes": "first"})
    assert res.status_code == 201
    m = res.json()
    assert m["name"] == "Alpha"
    assert m["status"] == "active"
    assert m["notes"] == "first"
    assert m["created_at"]
    assert client.get(f"/api/merchants/{m['id']}").json()["name"] == "Alpha"


def test_create_merchant_rejects_empty_name(client):
    assert client.post("/api/merchants", json={"name": ""}).status_code == 422


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
    a = client.post("/api/merchants", json={"name": "A"}).json()
    b = client.post("/api/merchants", json={"name": "B"}).json()
    client.patch(f"/api/merchants/{b['id']}", json={"status": "archived"})
    assert [m["id"] for m in client.get("/api/merchants", params={"status": "active"}).json()] == [a["id"]]
    assert [m["id"] for m in client.get("/api/merchants", params={"status": "archived"}).json()] == [b["id"]]
    assert len(client.get("/api/merchants").json()) == 2


def test_patch_merchant_fields(client):
    m = client.post("/api/merchants", json={"name": "Old"}).json()
    res = client.patch(f"/api/merchants/{m['id']}", json={"name": "New", "notes": "n2"})
    assert res.status_code == 200
    assert res.json()["name"] == "New"
    assert res.json()["notes"] == "n2"


def test_patch_merchant_rejects_bad_status(client):
    m = client.post("/api/merchants", json={"name": "M"}).json()
    assert client.patch(f"/api/merchants/{m['id']}", json={"status": "frozen"}).status_code == 422


def test_patch_merchant_rejects_explicit_null_on_required_fields(client):
    m = client.post("/api/merchants", json={"name": "M"}).json()
    assert client.patch(f"/api/merchants/{m['id']}", json={"name": None}).status_code == 422
    assert client.patch(f"/api/merchants/{m['id']}", json={"status": None}).status_code == 422


def test_patch_and_delete_missing_merchant_404(client):
    assert client.patch("/api/merchants/999", json={"name": "X"}).status_code == 404
    assert client.delete("/api/merchants/999").status_code == 404


def test_delete_merchant_without_tasks(client):
    m = client.post("/api/merchants", json={"name": "Gone"}).json()
    assert client.delete(f"/api/merchants/{m['id']}").status_code == 204
    assert client.get(f"/api/merchants/{m['id']}").status_code == 404


def test_delete_merchant_with_tasks_conflicts(client):
    m = client.post("/api/merchants", json={"name": "Busy"}).json()
    response = client.post(
        f"/api/merchants/{m['id']}/tasks",
        json={
            "task_type": "PREPARE_ONLY",
            "title": "Prepare work",
            "rationale": "Work is required",
            "expected_outcome": "Reviewable work",
            "parameters": {},
        },
    )
    assert response.status_code == 201
    assert client.delete(f"/api/merchants/{m['id']}").status_code == 409


def test_list_merchants_includes_work_stats(client):
    import os
    import sqlite3

    m = client.post("/api/merchants", json={"name": "S"}).json()
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
