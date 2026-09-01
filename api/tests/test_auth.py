def test_api_routes_require_an_operator_session(client):
    client.cookies.clear()

    response = client.get("/api/merchants")

    assert response.status_code == 401
    assert response.json()["detail"] == "operator authentication required"


def test_operator_can_login_and_logout_with_configured_test_account(client):
    client.cookies.clear()

    rejected = client.post(
        "/api/auth/login",
        json={"username": "test", "password": "wrong"},
    )
    assert rejected.status_code == 401

    logged_in = client.post(
        "/api/auth/login",
        json={"username": "test", "password": "seo-ops-test"},
    )
    assert logged_in.status_code == 200
    assert logged_in.json() == {"username": "test", "role": "operator"}
    assert client.get("/api/auth/me").json() == {
        "username": "test",
        "role": "operator",
    }
    assert client.get("/api/merchants").status_code == 200

    assert client.post("/api/auth/logout").status_code == 204
    assert client.get("/api/merchants").status_code == 401
