def make_merchant(client):
    return client.post("/api/merchants", json={"name": "M"}).json()


def make_task(client, merchant_id, **extra):
    return client.post(f"/api/merchants/{merchant_id}/tasks", json={"title": "t", **extra}).json()


def test_create_and_list_tasks(client):
    m = make_merchant(client)
    res = client.post(
        f"/api/merchants/{m['id']}/tasks",
        json={"title": "Fix GBP", "rationale": "ranking dropped", "description": "check listing"},
    )
    assert res.status_code == 201
    t = res.json()
    assert t["merchant_id"] == m["id"]
    assert t["status"] == "todo"
    assert t["rationale"] == "ranking dropped"
    assert t["evidence_note"] is None
    assert t["completed_at"] is None
    assert [x["id"] for x in client.get(f"/api/merchants/{m['id']}/tasks").json()] == [t["id"]]


def test_create_task_rejects_empty_title(client):
    m = make_merchant(client)
    assert client.post(f"/api/merchants/{m['id']}/tasks", json={"title": ""}).status_code == 422


def test_task_endpoints_404_on_missing(client):
    assert client.post("/api/merchants/999/tasks", json={"title": "t"}).status_code == 404
    assert client.get("/api/merchants/999/tasks").status_code == 404
    assert client.get("/api/tasks/999").status_code == 404
    assert client.patch("/api/tasks/999", json={"status": "doing"}).status_code == 404


def test_legal_transitions_todo_doing_done(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "doing"}).json()["status"] == "doing"
    done = client.patch(f"/api/tasks/{t['id']}", json={"status": "done"}).json()
    assert done["status"] == "done"
    assert done["completed_at"] is not None


def test_todo_straight_to_done_is_422(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "done"}).status_code == 422


def test_cancel_from_todo_and_doing(client):
    m = make_merchant(client)
    t1 = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t1['id']}", json={"status": "cancelled"}).json()["status"] == "cancelled"
    t2 = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t2['id']}", json={"status": "doing"})
    assert client.patch(f"/api/tasks/{t2['id']}", json={"status": "cancelled"}).json()["status"] == "cancelled"


def test_terminal_states_reject_transitions(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t['id']}", json={"status": "cancelled"})
    for s in ("todo", "doing", "done"):
        assert client.patch(f"/api/tasks/{t['id']}", json={"status": s}).status_code == 422


def test_same_status_patch_is_noop(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"}).status_code == 200


def test_patch_text_fields(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    res = client.patch(
        f"/api/tasks/{t['id']}",
        json={"rationale": "because", "evidence_note": "did it", "title": "T2", "description": "d2"},
    )
    body = res.json()
    assert body["rationale"] == "because"
    assert body["evidence_note"] == "did it"
    assert body["title"] == "T2"
    assert body["description"] == "d2"
    assert body["status"] == "todo"


def test_patch_task_rejects_explicit_null_title(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"title": None}).status_code == 422
