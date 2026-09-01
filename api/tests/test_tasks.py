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


def test_task_expected_outcome_create_patch_and_default(client):
    m = make_merchant(client)
    t = client.post(
        f"/api/merchants/{m['id']}/tasks",
        json={"title": "t", "rationale": "r", "expected_outcome": "地图曝光提升"},
    ).json()
    assert t["expected_outcome"] == "地图曝光提升"
    t2 = make_task(client, m["id"])
    assert t2["expected_outcome"] is None
    res = client.patch(f"/api/tasks/{t2['id']}", json={"expected_outcome": "评分回升"})
    assert res.json()["expected_outcome"] == "评分回升"


def test_task_category_create_patch_and_invalid(client):
    m = make_merchant(client)
    t = client.post(
        f"/api/merchants/{m['id']}/tasks",
        json={"title": "t", "category": "gbp"},
    ).json()
    assert t["category"] == "gbp"
    t2 = make_task(client, m["id"])
    assert t2["category"] is None
    assert client.patch(f"/api/tasks/{t2['id']}", json={"category": "review"}).json()["category"] == "review"
    assert client.post(f"/api/merchants/{m['id']}/tasks", json={"title": "t", "category": "nope"}).status_code == 422


def test_list_all_tasks_with_merchant_name(client):
    a = client.post("/api/merchants", json={"name": "甲"}).json()
    b = client.post("/api/merchants", json={"name": "乙"}).json()
    make_task(client, a["id"])
    make_task(client, b["id"])
    tasks = client.get("/api/tasks").json()
    names = {t["merchant_name"] for t in tasks}
    assert {"甲", "乙"} <= names


def test_batch_status_transitions(client):
    m = make_merchant(client)
    t1 = make_task(client, m["id"])  # todo -> doing 合法
    t2 = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t2['id']}", json={"status": "cancelled"})  # 终态，批量应跳过
    res = client.post("/api/tasks/batch", json={"ids": [t1["id"], t2["id"], 999], "status": "doing"})
    assert res.status_code == 200
    body = res.json()
    assert body["updated"] == [t1["id"]]
    assert set(body["skipped"]) == {t2["id"], 999}
    assert client.get(f"/api/tasks/{t1['id']}").json()["status"] == "doing"


def test_batch_done_sets_completed_at(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t['id']}", json={"status": "doing"})
    res = client.post("/api/tasks/batch", json={"ids": [t["id"]], "status": "done"})
    assert res.json()["updated"] == [t["id"]]
    assert client.get(f"/api/tasks/{t['id']}").json()["completed_at"] is not None


def test_batch_rejects_bad_status(client):
    assert client.post("/api/tasks/batch", json={"ids": [1], "status": "todo"}).status_code == 422
