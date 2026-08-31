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
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO tasks (merchant_id, title, created_at) VALUES (?, 't', '2026-08-31T00:00:00+00:00')",
        (m["id"],),
    )
    conn.commit()
    conn.close()
    assert client.delete(f"/api/merchants/{m['id']}").status_code == 409
