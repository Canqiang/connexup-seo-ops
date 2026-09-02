import json
import os
import sqlite3


KEYWORD_AGENT_ID = "keyword-agent"
AUDIT_AGENT_ID = "audit-agent"
RANKING_AGENT_ID = "ranking-agent"


def create_uws_merchant(client, monkeypatch):
    response = client.post(
        "/api/merchants",
        json={
            "name": "Choice Brooklyn - Upper West Side",
            "primary_location": "2040 Broadway, New York, NY 10023",
            "website_url": "https://www.choicebrooklyn.com/upperwestside",
        },
    )
    assert response.status_code == 201
    merchant_id = response.json()["id"]
    normalized = {
        "gbp_location_id": "locations/uws",
        "title": "Choice Brooklyn - Upper West Side",
        "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
        "address": "2040 Broadway, New York, NY 10023, US",
        "locality": "New York",
        "administrative_area": "NY",
        "postal_code": "10023",
        "region_code": "US",
        "website_url": "https://www.choicebrooklyn.com/",
        "description": "Specialty coffee, bakery, breakfast and brunch on the Upper West Side.",
        "primary_category": "Cafe",
        "additional_categories": ["Bakery", "Breakfast restaurant"],
        "regular_hours": [],
        "search_keywords": [
            {"month": "2026-07", "keyword": "coffee", "value": 6246},
            {"month": "2026-07", "keyword": "brunch", "value": 2376},
        ],
    }
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO merchant_gbp_profiles"
        " (merchant_id, fbr_merchant_id, gbp_location_id, source_title, normalized_json, synced_at)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (
            merchant_id,
            "fbr-choice",
            "locations/uws",
            normalized["title"],
            json.dumps(normalized),
            "2026-09-02T06:00:00+00:00",
        ),
    )
    conn.commit()
    conn.close()
    for name, value in {
        "COREAI_BASE_URL": "https://core-ai.test",
        "COREAI_API_KEY": "test-key",
        "COREAI_AGENT_ID": "planner-agent",
        "COREAI_KEYWORD_AGENT_ID": KEYWORD_AGENT_ID,
        "COREAI_AUDIT_AGENT_ID": AUDIT_AGENT_ID,
        "COREAI_RANKING_AGENT_ID": RANKING_AGENT_ID,
    }.items():
        monkeypatch.setenv(name, value)
    return merchant_id


def test_refresh_reads_persisted_fbr_keywords_without_triggering_an_agent(client, monkeypatch):
    from app import fbr_gbp
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)

    class PersistedKeywordClient:
        def get_local_keywords(self, place_id):
            assert place_id == "ChIJH8iZh-5ZwokRPLzzADeSnYE"
            return {
                "place_id": place_id,
                "local_keywords": [
                    {
                        "local_keyword_id": "local-keywords-uws",
                        "merchant_id": "fbr-choice",
                        "place_id": place_id,
                        "keywords": [
                            {
                                "keyword": "breakfast Upper West Side",
                                "priority": "P1",
                                "target_surface_types": ["GBP"],
                            },
                            {
                                "keyword": "bakery",
                                "priority": "P0",
                                "target_surface_types": ["GBP"],
                            },
                        ],
                    }
                ],
            }

    monkeypatch.setattr(fbr_gbp, "fbr_gbp_client", lambda: PersistedKeywordClient())

    def fail_if_agent_is_triggered(*_args, **_kwargs):
        raise AssertionError("persisted FBR keywords must win over Agent generation")

    monkeypatch.setattr(CoreAiClient, "trigger", fail_if_agent_is_triggered)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/refresh")

    assert response.status_code == 202
    state = response.json()
    assert state["cycle_status"] == "ready"
    assert state["active_stage"] is None
    assert state["keyword_set"]["generation_method"] == "PERSISTED_FBR_READBACK"
    assert [item["keyword"] for item in state["keyword_set"]["keywords"]] == [
        "breakfast Upper West Side",
        "bakery",
    ]
    assert state["keyword_set"]["keywords"][0]["priority"] == "P1"
    assert state["keyword_set"]["keywords"][0]["source_tags"] == [
        "FBR_KEYWORD_STORE",
        "FBR_LOCAL_KEYWORD_ID:local-keywords-uws",
    ]


def test_refresh_does_not_fall_back_to_the_legacy_agent_when_fbr_has_no_keywords(client, monkeypatch):
    from app import fbr_gbp
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)

    class EmptyKeywordClient:
        def get_local_keywords(self, place_id):
            return {"place_id": place_id, "local_keywords": []}

    monkeypatch.setattr(fbr_gbp, "fbr_gbp_client", lambda: EmptyKeywordClient())

    def fail_if_agent_is_triggered(*_args, **_kwargs):
        raise AssertionError("an empty FBR store must not invoke the legacy adapter agent")

    monkeypatch.setattr(CoreAiClient, "trigger", fail_if_agent_is_triggered)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/refresh")

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "FBR has no persisted keywords for this GBP location; "
        "configure the deterministic keyword Skill workflow before generating a new set"
    )


def test_refresh_uses_the_verified_keyword_skill_workflow_when_fbr_has_no_keywords(client, monkeypatch):
    from app import fbr_gbp
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)
    monkeypatch.setenv("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-agent")
    monkeypatch.setenv("COREAI_KEYWORD_SEED_SKILL_ID", "seed-skill")
    monkeypatch.setenv("COREAI_KEYWORD_RANKING_SKILL_ID", "ranking-skill")

    class EmptyKeywordClient:
        def get_local_keywords(self, place_id):
            return {"place_id": place_id, "local_keywords": []}

    monkeypatch.setattr(fbr_gbp, "fbr_gbp_client", lambda: EmptyKeywordClient())
    monkeypatch.setattr(
        CoreAiClient,
        "get_agent",
        lambda _self, agent_id: {
            "id": agent_id,
            "skill_ids": ["seed-skill", "ranking-skill"],
        },
    )
    captured = {}

    def fake_trigger(_self, agent_id, input_text):
        captured["agent_id"] = agent_id
        captured["request"] = json.loads(input_text)
        return {"run_id": "fallback-skill-run"}

    monkeypatch.setattr(CoreAiClient, "trigger", fake_trigger)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/refresh")

    assert response.status_code == 202
    assert response.json()["cycle_status"] == "running"
    assert captured["agent_id"] == "keyword-skill-agent"
    assert captured["request"]["workflow"]["stages"] == ["SEED", "RANK_AND_PRIORITIZE"]


def test_regenerate_requires_a_dedicated_keyword_skill_workflow(client, monkeypatch):
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)

    def fail_if_agent_is_triggered(*_args, **_kwargs):
        raise AssertionError("unconfigured regeneration must not trigger an Agent")

    monkeypatch.setattr(CoreAiClient, "trigger", fail_if_agent_is_triggered)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/regenerate")

    assert response.status_code == 503
    assert response.json()["detail"] == "deterministic keyword Skill workflow is not configured"


def test_regenerate_rejects_an_agent_missing_either_required_keyword_skill(client, monkeypatch):
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)
    monkeypatch.setenv("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-agent")
    monkeypatch.setenv("COREAI_KEYWORD_SEED_SKILL_ID", "seed-skill")
    monkeypatch.setenv("COREAI_KEYWORD_RANKING_SKILL_ID", "ranking-skill")
    monkeypatch.setattr(
        CoreAiClient,
        "get_agent",
        lambda _self, agent_id: {"id": agent_id, "skill_ids": ["seed-skill"]},
    )

    def fail_if_agent_is_triggered(*_args, **_kwargs):
        raise AssertionError("an Agent missing the ranking Skill must not run")

    monkeypatch.setattr(CoreAiClient, "trigger", fail_if_agent_is_triggered)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/regenerate")

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "configured keyword generation Agent is missing required seed and ranking Skills"
    )


def test_regenerate_triggers_only_the_verified_keyword_skill_agent(client, monkeypatch):
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)
    monkeypatch.setenv("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-agent")
    monkeypatch.setenv("COREAI_KEYWORD_SEED_SKILL_ID", "seed-skill")
    monkeypatch.setenv("COREAI_KEYWORD_RANKING_SKILL_ID", "ranking-skill")
    captured = {}
    monkeypatch.setattr(
        CoreAiClient,
        "get_agent",
        lambda _self, agent_id: {
            "id": agent_id,
            "skill_ids": ["seed-skill", "ranking-skill"],
        },
    )

    def fake_trigger(_self, agent_id, input_text):
        captured["agent_id"] = agent_id
        captured["request"] = json.loads(input_text)
        return {"run_id": "verified-keyword-run"}

    monkeypatch.setattr(CoreAiClient, "trigger", fake_trigger)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/regenerate")

    assert response.status_code == 202
    assert response.json()["cycle_status"] == "running"
    assert response.json()["capabilities"] == {"can_regenerate": True}
    assert captured["agent_id"] == "keyword-skill-agent"
    assert captured["request"]["workflow"] == {
        "seed_skill_id": "seed-skill",
        "ranking_skill_id": "ranking-skill",
        "stages": ["SEED", "RANK_AND_PRIORITIZE"],
    }


def test_polling_chains_keyword_audit_and_live_ranking_artifacts(client, monkeypatch):
    from app import seo_targets

    assert hasattr(seo_targets, "poll_seo_targets_once"), "SEO artifact polling is not implemented"
    merchant_id = create_uws_merchant(client, monkeypatch)

    conn = seo_targets.connect()
    merchant = seo_targets.fetch_merchant(conn, merchant_id)
    seo_targets._insert_running_artifact(
        conn,
        merchant_id=merchant_id,
        cycle_id="agent-pipeline-cycle",
        artifact_type="KEYWORD_SET",
        schema_version="seo_ops.keyword_set.v2",
        agent_id=KEYWORD_AGENT_ID,
        run_id="keyword-run-1",
        request=seo_targets.build_keyword_request(conn, merchant),
    )
    conn.commit()
    conn.close()

    keyword_set = {
        "schema_version": "seo_ops.keyword_set.v2",
        "merchant_id": str(merchant_id),
        "market": {
            "country_code": "US",
            "language": "en-US",
            "search_engine": "GOOGLE",
            "location_name": "Upper West Side, New York, NY",
        },
        "generation_method": "EVIDENCE_BOUNDED_RESEARCH",
        "title": "Choice UWS keyword set",
        "summary": "Confirmed US-market keyword set.",
        "keywords": [
            {
                "keyword": "coffee upper west side",
                "strategy": "LOCAL",
                "intent": "LOCAL",
                "priority": "UNSCORED",
                "rationale": "Matches the connected GBP category and location.",
                "source_tags": ["GBP_CATEGORY", "GBP_LOCATION"],
                "target_surface_types": ["GBP", "WEBSITE"],
                "target_location": "Upper West Side, New York, NY",
            }
        ],
        "evidence_gaps": ["Deterministic seed pipeline output was not supplied."],
    }
    audit_report = {
        "schema_version": "seo_ops.audit_report.v1",
        "merchant_id": str(merchant_id),
        "title": "Choice UWS evidence audit",
        "summary": "Connected and public evidence audit.",
        "evidence_mode": "CONNECTED_AND_CONFIRMED",
        "findings": [
            {
                "id": "missing-hours",
                "area": "GBP",
                "severity": "HIGH",
                "observation": "Regular hours are missing from the connected snapshot.",
                "evidence": ["FBR returned an empty regular_hours array."],
                "recommendation": "Confirm and publish regular hours after approval.",
            }
        ],
        "limitations": [],
        "next_actions": ["Confirm regular hours with the merchant."],
    }
    ranking_report = {
        "schema_version": "seo_ops.ranking_report.v1",
        "merchant_id": str(merchant_id),
        "title": "Choice UWS ranking baseline",
        "summary": "Live read-only ranking baseline.",
        "captured_at": "2026-09-02T06:30:00Z",
        "source_mode": "LIVE_READ_ONLY",
        "keywords": [
            {
                "keyword": "coffee upper west side",
                "local_rank": 3,
                "organic_rank": 8,
                "source": "LIVE_READ_ONLY",
                "note": "Measured through the attached read-only rank source.",
            }
        ],
        "limitations": [],
    }

    class PipelineCoreAi:
        def __init__(self):
            self.triggered = []

        def get_run(self, run_id):
            outputs = {
                "keyword-run-1": keyword_set,
                "audit-run-1": audit_report,
                "ranking-run-1": ranking_report,
            }
            return {
                "status": "COMPLETED",
                "output": json.dumps(outputs[run_id]),
                "completed_at": "2026-09-02T06:31:00Z",
            }

        def trigger(self, agent_id, input_text):
            request = json.loads(input_text)
            self.triggered.append((agent_id, request))
            if agent_id == AUDIT_AGENT_ID:
                assert request["schema_version"] == "seo_ops.audit_request.v1"
                assert request["upstream_artifacts"][0]["artifact_type"] == "KEYWORD_SET"
                return {"run_id": "audit-run-1"}
            if agent_id == RANKING_AGENT_ID:
                assert request["schema_version"] == "seo_ops.ranking_request.v1"
                assert {item["artifact_type"] for item in request["upstream_artifacts"]} == {
                    "KEYWORD_SET",
                    "AUDIT_REPORT",
                }
                return {"run_id": "ranking-run-1"}
            raise AssertionError(f"unexpected agent: {agent_id}")

    fake = PipelineCoreAi()
    agents = seo_targets.SeoAgentIds(KEYWORD_AGENT_ID, AUDIT_AGENT_ID, RANKING_AGENT_ID)
    seo_targets.poll_seo_targets_once(fake, agents)
    seo_targets.poll_seo_targets_once(fake, agents)
    seo_targets.poll_seo_targets_once(fake, agents)

    state = client.get(f"/api/merchants/{merchant_id}/seo-targets")
    assert state.status_code == 200
    assert state.json()["cycle_status"] == "ready"
    assert state.json()["active_stage"] is None
    assert state.json()["keyword_set"]["keywords"][0]["keyword"] == "coffee upper west side"
    assert state.json()["audit_report"]["findings"][0]["severity"] == "HIGH"
    assert state.json()["ranking_report"]["keywords"][0] == {
        "keyword": "coffee upper west side",
        "local_rank": 3,
        "organic_rank": 8,
        "source": "LIVE_READ_ONLY",
        "note": "Measured through the attached read-only rank source.",
    }


def test_get_keeps_saved_targets_visible_while_a_new_cycle_is_running(client, monkeypatch):
    merchant_id = create_uws_merchant(client, monkeypatch)
    saved_keyword_set = {"keywords": [{"keyword": "saved upper west side keyword"}]}
    saved_audit = {"findings": [{"id": "saved-finding"}]}
    saved_ranking = {"keywords": [{"keyword": "saved upper west side keyword", "local_rank": 4}]}
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.executemany(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " coreai_run_id, request_json, payload_json, created_at, completed_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)",
        [
            (merchant_id, "saved-cycle", "KEYWORD_SET", "seo_ops.keyword_set.v2", "ready", KEYWORD_AGENT_ID,
             "saved-keyword-run", json.dumps(saved_keyword_set), "2026-09-02T06:00:00Z", "2026-09-02T06:01:00Z"),
            (merchant_id, "saved-cycle", "AUDIT_REPORT", "seo_ops.audit_report.v1", "ready", AUDIT_AGENT_ID,
             "saved-audit-run", json.dumps(saved_audit), "2026-09-02T06:02:00Z", "2026-09-02T06:03:00Z"),
            (merchant_id, "saved-cycle", "RANKING_REPORT", "seo_ops.ranking_report.v1", "ready", RANKING_AGENT_ID,
             "saved-ranking-run", json.dumps(saved_ranking), "2026-09-02T06:04:00Z", "2026-09-02T06:05:00Z"),
            (merchant_id, "refresh-cycle", "KEYWORD_SET", "seo_ops.keyword_set.v2", "running", KEYWORD_AGENT_ID,
             "refresh-keyword-run", None, "2026-09-02T07:00:00Z", None),
        ],
    )
    conn.commit()
    conn.close()

    response = client.get(f"/api/merchants/{merchant_id}/seo-targets")

    assert response.status_code == 200
    assert response.json()["cycle_id"] == "refresh-cycle"
    assert response.json()["cycle_status"] == "running"
    assert response.json()["active_stage"] == "KEYWORD_SET"
    assert response.json()["keyword_set"] == saved_keyword_set
    assert response.json()["audit_report"] == saved_audit
    assert response.json()["ranking_report"] == saved_ranking


def insert_ready_keyword_set(merchant_id):
    keyword_set = {
        "schema_version": "seo_ops.keyword_set.v2",
        "merchant_id": str(merchant_id),
        "market": {
            "country_code": "US",
            "language": "en-US",
            "search_engine": "GOOGLE",
            "location_name": "Upper West Side, New York, NY",
        },
        "generation_method": "EVIDENCE_BOUNDED_RESEARCH",
        "title": "Choice UWS keyword set",
        "summary": "Accepted keyword set for Local Falcon synchronization.",
        "keywords": [
            {
                "keyword": "breakfast upper west side",
                "strategy": "LOCAL",
                "intent": "LOCAL",
                "priority": "UNSCORED",
                "rationale": "Confirmed local breakfast target.",
                "source_tags": ["GBP_LOCATION"],
                "target_surface_types": ["GBP"],
                "target_location": "Upper West Side, New York, NY",
            },
            {
                "keyword": "coffee near lincoln center",
                "strategy": "LOCAL",
                "intent": "LOCAL",
                "priority": "UNSCORED",
                "rationale": "Confirmed landmark target.",
                "source_tags": ["GBP_LOCATION"],
                "target_surface_types": ["GBP"],
                "target_location": "Upper West Side, New York, NY",
            },
            {
                "keyword": "breakfast nyc",
                "strategy": "ORGANIC",
                "intent": "ORGANIC",
                "priority": "UNSCORED",
                "rationale": "Citywide organic target.",
                "source_tags": ["GBP_CATEGORY"],
                "target_surface_types": ["WEBSITE"],
                "target_location": "New York, NY",
            },
        ],
        "evidence_gaps": [],
    }
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " request_json, payload_json, created_at, completed_at)"
        " VALUES (?, 'local-falcon-cycle', 'KEYWORD_SET', 'seo_ops.keyword_set.v2',"
        " 'ready', ?, '{}', ?, '2026-09-02T08:00:00Z', '2026-09-02T08:01:00Z')",
        (merchant_id, KEYWORD_AGENT_ID, json.dumps(keyword_set)),
    )
    conn.commit()
    conn.close()


class FakeLocalFalcon:
    def __init__(self, fail=False):
        self.fail = fail
        self.listed_keywords = []

    def list_latest_exact_report(self, place_id, keyword):
        from app.coreai import CoreAiError

        if self.fail:
            raise CoreAiError(0, "Local Falcon unavailable")
        assert place_id == "ChIJH8iZh-5ZwokRPLzzADeSnYE"
        self.listed_keywords.append(keyword)
        if keyword == "coffee near lincoln center":
            return None
        return {
            "report_key": "8aa3c7e1f6c599b",
            "date": "8/28/2026 12:00 PM",
            "keyword": "breakfast upper west side",
            "platform": "google",
        }

    def get_report(self, report_key):
        assert report_key == "8aa3c7e1f6c599b"
        return {
            "report_key": report_key,
            "date": "8/28/2026 12:00 PM",
            "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
            "platform": "google",
            "keyword": "breakfast upper west side",
            "lat": "40.7771028",
            "lng": "-73.9816854",
            "grid_size": "3",
            "radius": "0.5",
            "measurement": "km",
            "arp": "1.38",
            "atrp": "1.38",
            "solv": "93.83",
            "found_in": "9",
            "image": "https://lf-static.example/image/8aa3c7e1f6c599b",
            "heatmap": "https://lf-static.example/heatmap/8aa3c7e1f6c599b",
            "data_points": [
                {"lat": "40.2", "lng": "-73.2", "found": True, "rank": 1},
                {"lat": "40.1", "lng": "-73.2", "found": True, "rank": 1},
                {"lat": "40.0", "lng": "-73.2", "found": True, "rank": 2},
                {"lat": "40.2", "lng": "-73.1", "found": True, "rank": 1},
                {"lat": "40.1", "lng": "-73.1", "found": True, "rank": 1},
                {"lat": "40.0", "lng": "-73.1", "found": True, "rank": 3},
                {"lat": "40.2", "lng": "-73.0", "found": True, "rank": 2},
                {"lat": "40.1", "lng": "-73.0", "found": True, "rank": 4},
                {"lat": "40.0", "lng": "-73.0", "found": True, "rank": 8},
            ],
        }


def test_local_falcon_sync_persists_exact_local_reports_and_truthful_gaps(client, monkeypatch):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        response = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert response.status_code == 200
    local_falcon = response.json()["local_falcon"]
    assert local_falcon["status"] == "synced"
    assert local_falcon["missing_keywords"] == ["coffee near lincoln center"]
    assert fake.listed_keywords == [
        "breakfast upper west side",
        "coffee near lincoln center",
    ]
    report = local_falcon["reports"][0]
    assert report["report_key"] == "8aa3c7e1f6c599b"
    assert report["arp"] == 1.38
    assert report["atrp"] == 1.38
    assert report["solv"] == 93.83
    assert report["grid_size"] == 3
    assert report["found_in"] == 9
    assert len(report["grid_points"]) == 9

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    count = conn.execute(
        "SELECT COUNT(*) FROM merchant_local_falcon_reports WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()[0]
    conn.close()
    assert count == 1


def test_local_falcon_failure_preserves_last_successful_snapshot(client, monkeypatch):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    first = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: first
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        app.dependency_overrides[seo_targets.get_local_falcon] = lambda: FakeLocalFalcon(fail=True)
        failed = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets")
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert failed.status_code == 502
    assert state.status_code == 200
    assert state.json()["local_falcon"]["status"] == "failed"
    assert state.json()["local_falcon"]["reports"][0]["report_key"] == "8aa3c7e1f6c599b"
