import json
import os
import sqlite3
import threading

import pytest


KEYWORD_AGENT_ID = "keyword-agent"
AUDIT_AGENT_ID = "audit-agent"
RANKING_AGENT_ID = "ranking-agent"
TEST_PLACE_ID = "ChIJH8iZh-5ZwokRPLzzADeSnYE"
TEST_LOCATION_NAME = "2040 Broadway, New York, NY 10023, US"


def keyword_result(merchant_id, keywords, *, generation_method):
    return {
        "schema_version": "seo_ops.keyword_set.v2",
        "merchant_id": str(merchant_id),
        "market": {
            "country_code": "US",
            "language": "en-US",
            "search_engine": "GOOGLE",
            "location_name": TEST_LOCATION_NAME,
        },
        "generation_method": generation_method,
        "title": "Choice UWS keyword set",
        "summary": "Keyword workflow result.",
        "keywords": keywords,
        "evidence_gaps": [],
    }


def keyword_workflow_result(ranking_output, *, seed_output=None, ranking_input=None):
    seed_output = seed_output or {
        "schema_version": "seo_keyword_seed_output.v1",
        "place_id": TEST_PLACE_ID,
        "seeds": [
            {
                "keyword": "breakfast",
                "source": "GBP_CATEGORY",
                "confidence": 0.95,
            }
        ],
    }
    return {
        "schema_version": "seo_ops.keyword_workflow_result.v1",
        "seed_output": seed_output,
        "ranking_input": seed_output if ranking_input is None else ranking_input,
        "ranking_output": ranking_output,
    }


def ranking_skill_hybrid_output(merchant_id):
    """Shape emitted by the configured UAT workflow when response_schema is not enforced."""
    return {
        "merchant_id": str(merchant_id),
        "market": {
            "country_code": "US",
            "language": "en-US",
            "search_engine": "GOOGLE",
        },
        "location": {
            "id": f"merchant-{merchant_id}-location",
            "slug": "new-york-ny",
            "display_name": TEST_LOCATION_NAME,
            "external_identities": {
                "google_business": TEST_PLACE_ID,
            },
            "readiness_status": "READY",
        },
        "generation_method": "UPSTREAM_DETERMINISTIC_ADAPTER",
        "keywords": [
            {
                "keyword": "brunch near central park",
                "strategy": "LOCAL",
                "intent": "transactional",
                "priority": "P1",
                "score": 47,
                "score_rank": 1,
                "local_falcon_selected": True,
                "rationale": "Confirmed GBP search aligned with the merchant's brunch offering.",
                "source_tags": ["user_input.gbp_keywords"],
                "target_surface_types": ["GBP", "WEBSITE"],
                "target_location": TEST_LOCATION_NAME,
            },
            {
                "keyword": "choice brooklyn",
                "strategy": "ORGANIC",
                "intent": "navigational",
                "priority": "P0",
                "score": 100,
                "score_rank": None,
                "local_falcon_selected": False,
                "rationale": "Confirmed brand query.",
                "source_tags": ["user_input.brand_name"],
                "target_surface_types": ["WEBSITE"],
                "target_location": TEST_LOCATION_NAME,
            },
        ],
    }


def local_keyword(keyword, *, score=None, priority="UNSCORED"):
    return {
        "keyword": keyword,
        "strategy": "LOCAL",
        "intent": "LOCAL",
        "priority": priority,
        "score": score,
        "score_rank": None,
        "local_falcon_selected": False,
        "rationale": "Confirmed local target.",
        "source_tags": ["GBP_LOCATION"],
        "target_surface_types": ["GBP"],
        "target_location": "Upper West Side, New York, NY",
    }


def mark_deterministic_local_ranks(keyword_set):
    ordered = sorted(
        enumerate(keyword_set["keywords"]),
        key=lambda value: (-value[1]["score"], value[0]),
    )
    ranked = []
    for rank, (_, item) in enumerate(ordered, start=1):
        item["score_rank"] = rank
        item["local_falcon_selected"] = rank <= 20
        ranked.append(item)
    keyword_set["keywords"] = ranked
    return keyword_set


def test_keyword_workflow_envelope_accepts_exact_seed_to_ranking_lineage():
    from app import seo_targets

    ranked = mark_deterministic_local_ranks(
        keyword_result(
            7,
            [
                local_keyword("breakfast upper west side", score=95, priority="P0"),
                local_keyword("coffee near lincoln center", score=88, priority="P1"),
            ],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
    )

    artifact, lineage = seo_targets._parse_keyword_workflow_result(
        keyword_workflow_result(ranked),
        7,
        TEST_PLACE_ID,
        TEST_LOCATION_NAME,
    )

    assert artifact == ranked
    assert lineage["schema_version"] == "seo_ops.keyword_workflow_lineage.v2"
    assert lineage["seed_output_sha256"] == lineage["ranking_input_sha256"]
    assert lineage["ranking_output_sha256"] == lineage["artifact_sha256"]


def test_keyword_workflow_accepts_a_single_json_code_fence():
    from app import seo_targets

    ranked = mark_deterministic_local_ranks(
        keyword_result(
            7,
            [local_keyword("breakfast upper west side", score=95, priority="P0")],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
    )
    fenced = "```json\n" + json.dumps(keyword_workflow_result(ranked)) + "\n```"

    artifact, lineage = seo_targets._parse_keyword_workflow_result(
        fenced,
        7,
        TEST_PLACE_ID,
        TEST_LOCATION_NAME,
    )

    assert artifact == ranked
    assert lineage["ranking_output_sha256"] == lineage["artifact_sha256"]


def test_keyword_workflow_adapts_the_observed_fenced_keyword_set_variant():
    from app import seo_targets

    ranked = mark_deterministic_local_ranks(
        keyword_result(
            7,
            [
                local_keyword("breakfast upper west side", score=95, priority="P0"),
                local_keyword("coffee near lincoln center", score=88, priority="P1"),
            ],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
    )
    del ranked["market"]["location_name"]
    for item in ranked["keywords"]:
        item["strategy"] = item["strategy"].lower()
    fenced = "```json\n" + json.dumps(keyword_workflow_result(ranked)) + "\n```"

    artifact, lineage = seo_targets._parse_keyword_workflow_result(
        fenced,
        7,
        TEST_PLACE_ID,
        TEST_LOCATION_NAME,
    )

    assert artifact["market"]["location_name"] == TEST_LOCATION_NAME
    assert [item["strategy"] for item in artifact["keywords"]] == ["LOCAL", "LOCAL"]
    assert [item["score"] for item in artifact["keywords"]] == [95, 88]
    assert lineage["adapter_version"] == (
        "seo_ops.ranking_skill_keyword_set_adapter.v2"
    )
    assert lineage["ranking_output_sha256"] != lineage["artifact_sha256"]
    assert lineage["adapter_output_sha256"] == lineage["artifact_sha256"]
    assert seo_targets._workflow_lineage_v2_matches_artifact(
        lineage,
        lineage["artifact_sha256"],
        TEST_PLACE_ID,
    )


def test_keyword_workflow_adapts_the_versioned_uat_ranking_shape_without_losing_scores():
    from app import seo_targets

    raw_ranking_output = ranking_skill_hybrid_output(7)

    artifact, lineage = seo_targets._parse_keyword_workflow_result(
        keyword_workflow_result(raw_ranking_output),
        7,
        TEST_PLACE_ID,
        TEST_LOCATION_NAME,
    )

    assert artifact["schema_version"] == "seo_ops.keyword_set.v2"
    assert artifact["market"]["location_name"] == (
        "2040 Broadway, New York, NY 10023, US"
    )
    assert artifact["keywords"][0]["intent"] == "LOCAL"
    assert artifact["keywords"][0]["score"] == 47
    assert artifact["keywords"][0]["score_rank"] == 1
    assert artifact["keywords"][0]["local_falcon_selected"] is True
    assert artifact["keywords"][1]["intent"] == "BRAND"
    assert lineage["adapter_version"] == (
        "seo_ops.ranking_skill_output_adapter.v1"
    )
    assert lineage["ranking_output_sha256"] == seo_targets._sha256_json(
        raw_ranking_output
    )
    assert lineage["adapter_output_sha256"] == lineage["artifact_sha256"]
    assert seo_targets._workflow_lineage_v2_matches_artifact(
        lineage,
        lineage["artifact_sha256"],
        TEST_PLACE_ID,
    )

    tampered_hash = json.loads(json.dumps(lineage))
    tampered_hash["ranking_output_sha256"] = "0" * 64
    assert not seo_targets._workflow_lineage_v2_matches_artifact(
        tampered_hash,
        lineage["artifact_sha256"],
        TEST_PLACE_ID,
    )

    tampered_source = json.loads(json.dumps(lineage))
    tampered_source["source_ranking_output"]["keywords"][0]["score"] = 1
    assert not seo_targets._workflow_lineage_v2_matches_artifact(
        tampered_source,
        lineage["artifact_sha256"],
        TEST_PLACE_ID,
    )


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("unexpected", "not-in-the-observed-contract"),
        ("score_rank", "1"),
        ("local_falcon_selected", 1),
    ],
)
def test_keyword_workflow_adapter_rejects_unknown_or_coerced_hybrid_values(
    field,
    value,
):
    from app import seo_targets

    raw_ranking_output = ranking_skill_hybrid_output(7)
    if field == "unexpected":
        raw_ranking_output[field] = value
    else:
        raw_ranking_output["keywords"][0][field] = value

    with pytest.raises(ValueError):
        seo_targets._parse_keyword_workflow_result(
            keyword_workflow_result(raw_ranking_output),
            7,
            TEST_PLACE_ID,
            TEST_LOCATION_NAME,
        )


def test_keyword_workflow_adapter_rejects_a_different_google_business_identity():
    from app import seo_targets

    raw_ranking_output = ranking_skill_hybrid_output(7)
    raw_ranking_output["location"]["external_identities"][
        "google_business"
    ] = "WRONG_PLACE"

    with pytest.raises(ValueError, match="Google Business identity"):
        seo_targets._parse_keyword_workflow_result(
            keyword_workflow_result(raw_ranking_output),
            7,
            TEST_PLACE_ID,
            TEST_LOCATION_NAME,
        )


def test_keyword_workflow_rejects_a_direct_result_for_a_different_location():
    from app import seo_targets

    direct = mark_deterministic_local_ranks(
        keyword_result(
            7,
            [local_keyword("breakfast upper west side", score=95, priority="P0")],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
    )
    direct["market"]["location_name"] = "Different Place"

    with pytest.raises(ValueError, match="location name"):
        seo_targets._parse_keyword_workflow_result(
            keyword_workflow_result(direct),
            7,
            TEST_PLACE_ID,
            TEST_LOCATION_NAME,
        )


def test_keyword_workflow_envelope_rejects_ranking_input_that_is_not_the_seed_output():
    from app import seo_targets

    ranked = mark_deterministic_local_ranks(
        keyword_result(
            7,
            [local_keyword("breakfast upper west side", score=95, priority="P0")],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
    )
    envelope = keyword_workflow_result(
        ranked,
        ranking_input={"schema_version": "seo_keyword_seed_output.v1", "seeds": []},
    )

    with pytest.raises(ValueError, match="ranking_input must exactly match seed_output"):
        seo_targets._parse_keyword_workflow_result(
            envelope,
            7,
            TEST_PLACE_ID,
            TEST_LOCATION_NAME,
        )


def test_keyword_workflow_envelope_rejects_ranking_output_that_is_not_the_final_artifact():
    from app import seo_targets

    unranked = keyword_result(
        7,
        [local_keyword("breakfast upper west side", score=95, priority="P0")],
        generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
    )

    with pytest.raises(ValueError, match="ranking_output must be the final accepted KeywordSetV2"):
        seo_targets._parse_keyword_workflow_result(
            keyword_workflow_result(unranked),
            7,
            TEST_PLACE_ID,
            TEST_LOCATION_NAME,
        )


def test_keyword_parser_rejects_scored_evidence_bounded_research():
    from app import seo_targets

    result = keyword_result(
        7,
        [local_keyword("breakfast upper west side", score=95)],
        generation_method="EVIDENCE_BOUNDED_RESEARCH",
    )

    try:
        seo_targets._parse_keyword_set(result, 7)
    except ValueError as exc:
        assert "evidence-bounded" in str(exc)
    else:
        raise AssertionError("evidence-bounded scores must not become a paid cohort")


def test_keyword_parser_rejects_semantic_duplicate_keywords():
    from app import seo_targets

    result = keyword_result(
        7,
        [
            local_keyword("Breakfast Upper West Side", score=95, priority="P0"),
            local_keyword("  breakfast upper west side  ", score=90, priority="P1"),
        ],
        generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
    )

    try:
        seo_targets._parse_keyword_set(result, 7)
    except ValueError as exc:
        assert "duplicate" in str(exc)
    else:
        raise AssertionError("semantic duplicates must not create duplicate paid scans")


def test_keyword_parser_rejects_unicode_and_collapsed_whitespace_duplicates():
    from app import seo_targets

    result = keyword_result(
        7,
        [
            local_keyword("coffee  near me", score=95, priority="P0"),
            local_keyword("ＣＯＦＦＥＥ\u00a0near me", score=90, priority="P1"),
        ],
        generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
    )

    try:
        seo_targets._parse_keyword_set(result, 7)
    except ValueError as exc:
        assert "duplicate" in str(exc)
    else:
        raise AssertionError(
            "Unicode and whitespace variants must not create duplicate paid scans"
        )


def test_local_falcon_cohort_deduplicates_unicode_identity_and_preserves_display_text():
    from app import seo_targets

    keyword_set = keyword_result(
        7,
        [
            local_keyword("Coffee  Near Me", score=95, priority="P0"),
            local_keyword("ＣＯＦＦＥＥ\u00a0near me", score=90, priority="P1"),
        ],
        generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
    )
    for rank, item in enumerate(keyword_set["keywords"], start=1):
        item["score_rank"] = rank
        item["local_falcon_selected"] = True

    cohort = seo_targets._local_falcon_cohort_snapshot(keyword_set)

    assert cohort == [
        {"keyword": "Coffee  Near Me", "score": 95, "score_rank": 1}
    ]


def test_local_falcon_cohort_hash_uses_keyword_identity_not_display_formatting():
    from app import seo_targets

    def keyword_set_for(display_text):
        result = keyword_result(
            7,
            [local_keyword(display_text, score=95, priority="P0")],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
        result["keywords"][0]["score_rank"] = 1
        result["keywords"][0]["local_falcon_selected"] = True
        return result

    assert seo_targets._local_falcon_cohort_sha256(
        keyword_set_for("Coffee  Near Me")
    ) == seo_targets._local_falcon_cohort_sha256(
        keyword_set_for("ＣＯＦＦＥＥ\u00a0near me")
    )


def test_keyword_parser_rejects_coerced_scores_before_forming_a_paid_cohort():
    from app import seo_targets

    for invalid_score in (True, False, "95"):
        result = keyword_result(
            7,
            [local_keyword("breakfast upper west side", score=invalid_score, priority="P0")],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
        try:
            seo_targets._parse_keyword_set(result, 7)
        except ValueError:
            pass
        else:
            raise AssertionError(f"coerced score {invalid_score!r} must not enter a paid cohort")


def test_local_falcon_credit_confirmation_rejects_coerced_truthy_values():
    from app.seo_targets import LocalFalconScanBatchRequest

    valid = {
        "approval_id": 1,
        "request_id": "explicit-credit-confirmation",
        "expected_scan_config_sha256": "a" * 64,
    }
    for invalid_confirmation in (1, "1", "yes"):
        try:
            LocalFalconScanBatchRequest.model_validate(
                {**valid, "confirm_credit_spend": invalid_confirmation}
            )
        except ValueError:
            pass
        else:
            raise AssertionError(
                f"credit confirmation {invalid_confirmation!r} must be an explicit boolean"
            )


def test_keyword_skill_provenance_requires_exact_completed_seed_then_ranking_spans():
    from app import seo_targets

    request = {
        "execution_spec": {
            "google_business_id": TEST_PLACE_ID,
            "display_name": TEST_LOCATION_NAME,
        },
        "workflow": {
            "seed_skill_id": "seed-skill",
            "ranking_skill_id": "ranking-skill",
            "seed_skill": {
                "id": "seed-skill",
                "qualified_name": "fbradmin/seo-keyword-seed-generate",
                "version": None,
            },
            "ranking_skill": {
                "id": "ranking-skill",
                "qualified_name": "fbradmin/seo-keyword-ranking-optimize",
                "version": None,
            },
            "stages": ["SEED", "RANK_AND_PRIORITIZE"],
        }
    }

    class TraceClient:
        def get_trace(self, trace_id):
            return {
                "traceId": trace_id,
                "agentId": "keyword-skill-agent",
                "status": "COMPLETED",
            }

        def list_trace_spans(self, _trace_id):
            return [
                {"spanId": "seed-span", "name": "use_skill", "type": "TOOL"},
                {"spanId": "ranking-span", "name": "use_skill", "type": "TOOL"},
            ]

        def get_trace_span(self, _trace_id, span_id):
            values = {
                "seed-span": (
                    "fbradmin/seo-keyword-seed-generate",
                    "2026-09-02T07:00:00Z",
                    "2026-09-02T07:00:01Z",
                ),
                "ranking-span": (
                    "fbradmin/seo-keyword-ranking-optimize",
                    "2026-09-02T07:00:02Z",
                    "2026-09-02T07:00:03Z",
                ),
            }
            name, started, completed = values[span_id]
            return {
                "spanId": span_id,
                "name": "use_skill",
                "type": "TOOL",
                "status": "OK",
                "input": json.dumps({"name": name}),
                "output": "ToolCallResult{status=COMPLETED, toolName='use_skill'}",
                "startedAt": started,
                "completedAt": completed,
            }

    payload = keyword_result(
        7,
        [local_keyword("breakfast upper west side", score=95, priority="P0")],
        generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
    )
    payload = mark_deterministic_local_ranks(payload)
    seed_output = {"place_id": TEST_PLACE_ID, "seeds": ["breakfast"]}
    lineage = {
        "schema_version": "seo_ops.keyword_workflow_lineage.v2",
        "seed_output_sha256": seo_targets._sha256_json(seed_output),
        "source_seed_output": seed_output,
        "ranking_input_sha256": seo_targets._sha256_json(seed_output),
        "ranking_output_sha256": seo_targets._sha256_json(payload),
        "source_ranking_output": payload,
        "adapter_version": None,
        "adapter_output_sha256": seo_targets._sha256_json(payload),
        "artifact_sha256": seo_targets._sha256_json(payload),
    }
    evidence = seo_targets._verify_keyword_skill_provenance(
        TraceClient(),
        core={"trace_id": "trace-1"},
        request=request,
        source_agent_id="keyword-skill-agent",
        run_id="run-1",
        payload=payload,
        lineage=lineage,
    )

    assert evidence["status"] == "VERIFIED"
    assert evidence["method"] == "CORE_AI_SKILL_LOAD_TRACE_AND_WORKFLOW_LINEAGE_V2"
    assert [item["span_id"] for item in evidence["skill_instruction_loads"]] == [
        "seed-span",
        "ranking-span",
    ]
    assert evidence["workflow_lineage"] == lineage


def test_keyword_skill_provenance_does_not_accept_a_wrapper_skill_as_seed_and_ranking():
    from app import seo_targets

    class WrapperOnlyTrace:
        def get_trace(self, trace_id):
            return {
                "traceId": trace_id,
                "agentId": "keyword-skill-agent",
                "status": "COMPLETED",
            }

        def list_trace_spans(self, _trace_id):
            return [{"spanId": "wrapper", "name": "use_skill", "type": "TOOL"}]

        def get_trace_span(self, _trace_id, _span_id):
            return {
                "spanId": "wrapper",
                "name": "use_skill",
                "type": "TOOL",
                "status": "OK",
                "input": '{"name":"Xander/seo-ops-keyword-set"}',
                "output": "ToolCallResult{status=COMPLETED, toolName='use_skill'}",
                "startedAt": "2026-09-02T07:00:00Z",
                "completedAt": "2026-09-02T07:00:01Z",
            }

    request = {
        "workflow": {
            "seed_skill": {
                "id": "seed-skill",
                "qualified_name": "fbradmin/seo-keyword-seed-generate",
            },
            "ranking_skill": {
                "id": "ranking-skill",
                "qualified_name": "fbradmin/seo-keyword-ranking-optimize",
            },
        }
    }

    try:
        seo_targets._verify_keyword_skill_provenance(
            WrapperOnlyTrace(),
            core={"trace_id": "trace-1"},
            request=request,
            source_agent_id="keyword-skill-agent",
            run_id="run-1",
            payload={"schema_version": "seo_ops.keyword_set.v2"},
            lineage={"schema_version": "seo_ops.keyword_workflow_lineage.v1"},
        )
    except seo_targets.KeywordSkillProvenancePending:
        pass
    else:
        raise AssertionError("a wrapper Skill must not attest the required Seed and Ranking Skills")


def test_archived_merchant_rejects_seo_target_refresh(client):
    merchant = client.post(
        "/api/merchants",
        json={"name": "Archived SEO", "primary_location": "Mineola, NY"},
    ).json()
    client.patch(f"/api/merchants/{merchant['id']}", json={"status": "archived"})

    response = client.post(f"/api/merchants/{merchant['id']}/seo-targets/refresh")

    assert response.status_code == 409
    assert response.json()["detail"] == "merchant is archived"


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
    assert state["keyword_set"]["keywords"][0]["score"] is None
    assert state["keyword_set"]["keywords"][0]["score_rank"] is None
    assert state["keyword_set"]["keywords"][0]["local_falcon_selected"] is False
    assert state["capabilities"]["can_sync_local_falcon"] is False


def test_fbr_keyword_normalization_chooses_the_highest_semantic_duplicate_score_stably(
    client, monkeypatch
):
    from app import fbr_gbp

    merchant_id = create_uws_merchant(client, monkeypatch)

    class DuplicateKeywordClient:
        def get_local_keywords(self, place_id):
            return {
                "place_id": place_id,
                "local_keywords": [
                    {
                        "local_keyword_id": "first-source",
                        "keywords": [
                            {
                                "keyword": "ＣＯＦＦＥＥ\u00a0near me",
                                "priority": "P2",
                                "score": 40,
                                "target_surface_types": ["GBP"],
                            },
                            {
                                "keyword": "Brunch Upper West Side",
                                "priority": "P1",
                                "score": 70,
                                "target_surface_types": ["GBP"],
                            },
                            {
                                "keyword": "Bakery Upper West Side",
                                "priority": "UNSCORED",
                                "score": None,
                                "target_surface_types": ["GBP"],
                            },
                            {
                                "keyword": "First tied keyword",
                                "priority": "P1",
                                "score": 80,
                                "target_surface_types": ["GBP"],
                            },
                            {
                                "keyword": "Second tied keyword",
                                "priority": "P1",
                                "score": 80,
                                "target_surface_types": ["GBP"],
                            },
                        ],
                    },
                    {
                        "local_keyword_id": "higher-score-source",
                        "keywords": [
                            {
                                "keyword": "coffee near me",
                                "priority": "P0",
                                "score": 95,
                                "target_surface_types": ["GBP", "WEBSITE"],
                            },
                            {
                                "keyword": "ＢＲＵＮＣＨ　UPPER WEST SIDE",
                                "priority": "P0",
                                "score": 70,
                                "target_surface_types": ["WEBSITE"],
                            },
                            {
                                "keyword": "ＢＡＫＥＲＹ\u00a0upper west side",
                                "priority": "P1",
                                "score": 55,
                                "target_surface_types": ["GBP"],
                            },
                            {
                                "keyword": "First Tied Keyword",
                                "priority": "P0",
                                "score": 80,
                                "target_surface_types": ["WEBSITE"],
                            },
                        ],
                    },
                ],
            }

    monkeypatch.setattr(fbr_gbp, "fbr_gbp_client", lambda: DuplicateKeywordClient())

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/refresh")

    assert response.status_code == 202
    keywords = response.json()["keyword_set"]["keywords"]
    assert [item["keyword"] for item in keywords] == [
        "coffee near me",
        "First tied keyword",
        "Second tied keyword",
        "Brunch Upper West Side",
        "ＢＡＫＥＲＹ\u00a0upper west side",
    ]
    assert [item["score"] for item in keywords] == [95, 80, 80, 70, 55]
    assert keywords[0]["priority"] == "P0"
    assert keywords[0]["source_tags"] == [
        "FBR_KEYWORD_STORE",
        "FBR_LOCAL_KEYWORD_ID:higher-score-source",
    ]
    # Equal scores keep the first display spelling and source payload.
    assert keywords[3]["priority"] == "P1"
    assert keywords[3]["target_surface_types"] == ["GBP"]
    assert keywords[3]["source_tags"] == [
        "FBR_KEYWORD_STORE",
        "FBR_LOCAL_KEYWORD_ID:first-source",
    ]
    assert keywords[1]["score_rank"] == 2
    assert keywords[2]["score_rank"] == 3


def test_fbr_readback_collapses_unicode_keyword_duplicates_and_keeps_first_display_text():
    from app import seo_targets

    keyword_set = seo_targets._fbr_local_keyword_set(
        {"id": 7, "name": "Choice UWS"},
        {
            "place_id": "place-1",
            "title": "Choice UWS",
            "address": "Upper West Side, New York, NY",
        },
        {
            "place_id": "place-1",
            "local_keywords": [
                {
                    "local_keyword_id": "group-1",
                    "keywords": [
                        {
                            "keyword": "Coffee  Near Me",
                            "priority": "P0",
                            "score": 95,
                            "target_surface_types": ["GBP"],
                        },
                        {
                            "keyword": "ＣＯＦＦＥＥ\u00a0near me",
                            "priority": "P1",
                            "score": 90,
                            "target_surface_types": ["GBP"],
                        },
                    ],
                }
            ],
        },
    )

    assert keyword_set is not None
    assert [item["keyword"] for item in keyword_set["keywords"]] == [
        "Coffee  Near Me"
    ]


def test_refresh_orders_scored_fbr_keywords_and_selects_only_top_20_for_local_falcon(
    client, monkeypatch
):
    from app.main import app
    from app import fbr_gbp
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    previous_artifact_id = insert_verified_skill_keyword_set(
        merchant_id,
        cycle_id="previous-verified-skill-cycle",
    )
    monkeypatch.setenv("COREAI_LOCAL_FALCON_TOOL_ID", "local-falcon-tool")

    class RankedKeywordClient:
        def get_local_keywords(self, place_id):
            return {
                "place_id": place_id,
                "local_keywords": [
                    {
                        "local_keyword_id": "ranked-local-keywords-uws",
                        "merchant_id": "fbr-choice",
                        "place_id": place_id,
                        "keywords": [
                            {
                                "keyword": f"ranked keyword {index:02d}",
                                "priority": "P1",
                                "score": index + 0.25,
                                "target_surface_types": ["GBP"],
                            }
                            for index in range(21)
                        ],
                    }
                ],
            }

    monkeypatch.setattr(fbr_gbp, "fbr_gbp_client", lambda: RankedKeywordClient())

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/refresh")

    assert response.status_code == 202
    state = response.json()
    assert state["keyword_set_artifact_id"] != previous_artifact_id
    keywords = state["keyword_set"]["keywords"]
    assert [item["keyword"] for item in keywords] == [
        f"ranked keyword {index:02d}" for index in range(20, -1, -1)
    ]
    assert [item["score"] for item in keywords] == [
        index + 0.25 for index in range(20, -1, -1)
    ]
    assert [item["score_rank"] for item in keywords] == list(range(1, 22))
    assert [item["local_falcon_selected"] for item in keywords] == [True] * 20 + [False]
    assert state["capabilities"]["can_sync_local_falcon"] is True

    class MissingLocalFalcon:
        def __init__(self):
            self.listed_keywords = []

        def list_latest_exact_report(self, place_id, keyword):
            assert place_id == "ChIJH8iZh-5ZwokRPLzzADeSnYE"
            self.listed_keywords.append(keyword)
            return None

    fake = MissingLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        sync = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert sync.status_code == 200, sync.text
    assert fake.listed_keywords == [
        f"ranked keyword {index:02d}" for index in range(20, 0, -1)
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
        "use the explicit regenerate action to create a new scored set"
    )


def test_refresh_never_invokes_skills_when_fbr_has_no_keywords(client, monkeypatch):
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
    def fail_if_agent_is_triggered(*_args, **_kwargs):
        raise AssertionError("refresh must remain a read-only FBR operation")

    monkeypatch.setattr(CoreAiClient, "trigger", fail_if_agent_is_triggered)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/refresh")

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "FBR has no persisted keywords for this GBP location; "
        "use the explicit regenerate action to create a new scored set"
    )


def test_regenerate_requires_a_dedicated_keyword_skill_workflow(client, monkeypatch):
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)

    def fail_if_agent_is_triggered(*_args, **_kwargs):
        raise AssertionError("unconfigured regeneration must not trigger an Agent")

    monkeypatch.setattr(CoreAiClient, "trigger", fail_if_agent_is_triggered)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/regenerate")

    assert response.status_code == 503
    assert response.json()["detail"] == "deterministic keyword Skill workflow is not configured"


def test_regenerate_requires_both_skills_to_be_bound_before_triggering(
    client, monkeypatch
):
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
    monkeypatch.setattr(
        CoreAiClient,
        "get_skill",
        lambda _self, skill_id: {
            "id": skill_id,
            "qualified_name": (
                "fbradmin/seo-keyword-seed-generate"
                if skill_id == "seed-skill"
                else "fbradmin/seo-keyword-ranking-optimize"
            ),
            "version": None,
        },
    )
    triggered = []
    monkeypatch.setattr(CoreAiClient, "trigger", lambda *_args, **_kwargs: triggered.append(True))

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/regenerate")

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "keyword Skill Agent is not bound to both configured Seed and Ranking Skills"
    )
    assert triggered == []


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
    monkeypatch.setattr(
        CoreAiClient,
        "get_skill",
        lambda _self, skill_id: {
            "id": skill_id,
            "qualified_name": (
                "fbradmin/seo-keyword-seed-generate"
                if skill_id == "seed-skill"
                else "fbradmin/seo-keyword-ranking-optimize"
            ),
            "version": None,
            "updated_at": "2026-09-02T06:00:00Z",
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
    capabilities = response.json()["capabilities"]
    assert {
        key: capabilities[key]
        for key in (
            "can_regenerate",
            "can_sync_local_falcon",
            "can_approve_local_falcon",
            "can_generate_local_falcon",
        )
    } == {
        "can_regenerate": False,
        "can_sync_local_falcon": False,
        "can_approve_local_falcon": False,
        "can_generate_local_falcon": False,
    }
    assert "keyword_regeneration_running" in capabilities["blockers"]["regenerate"]
    assert "keyword_regeneration_running" in capabilities["blockers"]["approve_local_falcon"]
    assert captured["agent_id"] == "keyword-skill-agent"
    assert captured["request"]["workflow"]["seed_skill"] == {
        "id": "seed-skill",
        "qualified_name": "fbradmin/seo-keyword-seed-generate",
        "version": None,
        "updated_at": "2026-09-02T06:00:00Z",
    }
    assert captured["request"]["workflow"]["ranking_skill"] == {
        "id": "ranking-skill",
        "qualified_name": "fbradmin/seo-keyword-ranking-optimize",
        "version": None,
        "updated_at": "2026-09-02T06:00:00Z",
    }
    assert captured["request"]["workflow"]["stages"] == [
        "SEED",
        "RANK_AND_PRIORITIZE",
    ]
    assert captured["request"]["output_schema_version"] == (
        "seo_ops.keyword_workflow_result.v1"
    )
    assert captured["request"]["workflow"]["result_schema_version"] == (
        "seo_ops.keyword_workflow_result.v1"
    )
    output_contract = captured["request"]["workflow"]["ranking_output_contract"]
    assert output_contract["schema_version"] == "seo_ops.keyword_set.v2"
    assert set(output_contract["required"]) == {
        "schema_version",
        "merchant_id",
        "market",
        "generation_method",
        "title",
        "summary",
        "keywords",
        "evidence_gaps",
    }
    assert output_contract["intent_values"] == [
        "LOCAL",
        "ORGANIC",
        "BRAND",
        "MENU",
        "NEAR_ME",
    ]
    assert output_contract["strategy_values"] == ["LOCAL", "ORGANIC"]
    assert output_contract["market_required"] == [
        "country_code",
        "language",
        "search_engine",
        "location_name",
    ]
    assert output_contract["additional_properties"] is False
    assert "do_not_wrap_json_in_markdown_code_fences" in captured["request"]["rules"]


def test_keyword_regeneration_marks_dispatching_before_the_remote_trigger(
    client, monkeypatch
):
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)
    monkeypatch.setenv("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-agent")
    monkeypatch.setenv("COREAI_KEYWORD_SEED_SKILL_ID", "seed-skill")
    monkeypatch.setenv("COREAI_KEYWORD_RANKING_SKILL_ID", "ranking-skill")
    monkeypatch.setattr(
        CoreAiClient,
        "get_agent",
        lambda _self, agent_id: {
            "id": agent_id,
            "skill_ids": ["seed-skill", "ranking-skill"],
        },
    )
    monkeypatch.setattr(
        CoreAiClient,
        "get_skill",
        lambda _self, skill_id: {
            "id": skill_id,
            "qualified_name": (
                "fbradmin/seo-keyword-seed-generate"
                if skill_id == "seed-skill"
                else "fbradmin/seo-keyword-ranking-optimize"
            ),
            "version": None,
            "updated_at": "2026-09-02T06:00:00Z",
        },
    )

    def inspect_durable_claim_before_trigger(_self, _agent_id, _input_text):
        conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT dispatch_state, dispatch_started_at, coreai_run_id, request_json"
            " FROM merchant_seo_artifacts WHERE merchant_id = ? ORDER BY id DESC LIMIT 1",
            (merchant_id,),
        ).fetchone()
        conn.close()
        assert row["dispatch_state"] == "dispatching"
        assert row["dispatch_started_at"] is not None
        assert row["coreai_run_id"] is None
        assert json.loads(row["request_json"])["workflow"]["stages"] == [
            "SEED",
            "RANK_AND_PRIORITIZE",
        ]
        return {"run_id": "durably-dispatched-keyword-run"}

    monkeypatch.setattr(CoreAiClient, "trigger", inspect_durable_claim_before_trigger)

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/regenerate")

    assert response.status_code == 202
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT dispatch_state, dispatch_started_at, coreai_run_id"
        " FROM merchant_seo_artifacts WHERE merchant_id = ? ORDER BY id DESC LIMIT 1",
        (merchant_id,),
    ).fetchone()
    conn.close()
    assert row["dispatch_state"] == "dispatched"
    assert row["dispatch_started_at"] is not None
    assert row["coreai_run_id"] == "durably-dispatched-keyword-run"


def test_stale_keyword_dispatch_fails_closed_without_automatic_retrigger_and_allows_manual_retry(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " coreai_run_id, request_json, dispatch_state, dispatch_started_at, created_at)"
        " VALUES (?, 'crashed-dispatch-cycle', 'KEYWORD_SET', 'seo_ops.keyword_set.v2',"
        " 'running', 'keyword-skill-agent', NULL, '{}', 'dispatching',"
        " '2020-01-01T00:00:00+00:00', '2020-01-01T00:00:00+00:00')",
        (merchant_id,),
    )
    conn.commit()
    conn.close()

    class NoAutomaticRemoteCall:
        def get_run(self, _run_id):
            raise AssertionError("a run without a persisted id cannot be polled")

        def trigger(self, _agent_id, _input_text):
            raise AssertionError("stale recovery must never automatically retrigger")

    seo_targets.poll_seo_targets_once(
        NoAutomaticRemoteCall(),
        seo_targets.SeoAgentIds("keyword-skill-agent", "", ""),
    )

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.row_factory = sqlite3.Row
    stale = conn.execute(
        "SELECT status, dispatch_state, coreai_run_id, error, completed_at"
        " FROM merchant_seo_artifacts WHERE cycle_id = 'crashed-dispatch-cycle'"
    ).fetchone()
    conn.close()
    assert stale["status"] == "failed"
    assert stale["dispatch_state"] == "unknown"
    assert stale["coreai_run_id"] is None
    assert "outcome is unknown" in stale["error"]
    assert "manually" in stale["error"]
    assert stale["completed_at"] is not None

    class ManualRetryWorkflow:
        def __init__(self):
            self.trigger_count = 0

        def get_agent(self, agent_id):
            return {
                "id": agent_id,
                "skill_ids": ["seed-skill", "ranking-skill"],
            }

        def get_skill(self, skill_id):
            return {
                "id": skill_id,
                "qualified_name": (
                    "fbradmin/seo-keyword-seed-generate"
                    if skill_id == "seed-skill"
                    else "fbradmin/seo-keyword-ranking-optimize"
                ),
                "version": None,
                "updated_at": "2026-09-02T06:00:00Z",
            }

        def trigger(self, _agent_id, _input_text):
            self.trigger_count += 1
            return {"run_id": "explicit-manual-retry-run"}

    retry_client = ManualRetryWorkflow()
    app.dependency_overrides[seo_targets.get_keyword_skill_workflow] = lambda: (
        retry_client,
        seo_targets.KeywordSkillWorkflow(
            "keyword-skill-agent", "seed-skill", "ranking-skill"
        ),
    )
    try:
        retried = client.post(f"/api/merchants/{merchant_id}/seo-targets/regenerate")
    finally:
        app.dependency_overrides.pop(seo_targets.get_keyword_skill_workflow, None)

    assert retried.status_code == 202
    assert retry_client.trigger_count == 1
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.row_factory = sqlite3.Row
    latest = conn.execute(
        "SELECT status, dispatch_state, coreai_run_id"
        " FROM merchant_seo_artifacts WHERE merchant_id = ? ORDER BY id DESC LIMIT 1",
        (merchant_id,),
    ).fetchone()
    conn.close()
    assert latest["status"] == "running"
    assert latest["dispatch_state"] == "dispatched"
    assert latest["coreai_run_id"] == "explicit-manual-retry-run"


def test_skill_only_regeneration_accepts_observed_adapter_and_finishes_payable(
    client, monkeypatch
):
    from app import seo_targets
    from app.coreai import CoreAiClient

    merchant_id = create_uws_merchant(client, monkeypatch)
    monkeypatch.setenv("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-agent")
    monkeypatch.setenv("COREAI_KEYWORD_SEED_SKILL_ID", "seed-skill")
    monkeypatch.setenv("COREAI_KEYWORD_RANKING_SKILL_ID", "ranking-skill")
    monkeypatch.setenv("COREAI_LOCAL_FALCON_TOOL_ID", "local-falcon-tool")
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO merchant_local_falcon_reports"
        " (merchant_id, report_key, place_id, keyword, platform, captured_at,"
        " center_lat, center_lng, grid_size, radius, measurement, arp, atrp, solv,"
        " found_in, image_url, heatmap_url, grid_points_json, synced_at)"
        " VALUES (?, 'defaults-report', ?, 'existing keyword', 'google',"
        " '2026-09-02T06:00:00Z', 40.7829, -73.9813, 9, 0.5, 'km',"
        " 4.0, 5.0, 40.0, 81, NULL, NULL, '[]', '2026-09-02T06:00:00Z')",
        (merchant_id, TEST_PLACE_ID),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(
        CoreAiClient,
        "get_agent",
        lambda _self, agent_id: {
            "id": agent_id,
            "skill_ids": ["seed-skill", "ranking-skill"],
        },
    )
    monkeypatch.setattr(
        CoreAiClient,
        "get_skill",
        lambda _self, skill_id: {
            "id": skill_id,
            "qualified_name": (
                "fbradmin/seo-keyword-seed-generate"
                if skill_id == "seed-skill"
                else "fbradmin/seo-keyword-ranking-optimize"
            ),
            "version": None,
            "updated_at": "2026-09-02T06:00:00Z",
        },
    )
    monkeypatch.setattr(
        CoreAiClient,
        "trigger",
        lambda *_args, **_kwargs: {"run_id": "verified-skill-only-run"},
    )
    started = client.post(f"/api/merchants/{merchant_id}/seo-targets/regenerate")
    assert started.status_code == 202

    payload = keyword_result(
        merchant_id,
        [
            local_keyword("breakfast upper west side", score=95, priority="P0"),
            local_keyword("coffee near lincoln center", score=88, priority="P1"),
        ],
        generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
    )
    payload = mark_deterministic_local_ranks(payload)
    workflow_output = keyword_workflow_result(payload)
    del workflow_output["ranking_output"]["market"]["location_name"]
    for item in workflow_output["ranking_output"]["keywords"]:
        item["strategy"] = item["strategy"].lower()
    observed_output = "```json\n" + json.dumps(workflow_output) + "\n```"

    class CompletedSkillRun:
        triggered = []

        def get_run(self, run_id):
            assert run_id == "verified-skill-only-run"
            return {
                "status": "COMPLETED",
                "output": observed_output,
                "completed_at": "2026-09-02T07:00:04Z",
                "trace_id": "verified-trace",
            }

        def get_trace(self, trace_id):
            return {
                "traceId": trace_id,
                "agentId": "keyword-skill-agent",
                "status": "COMPLETED",
            }

        def list_trace_spans(self, _trace_id):
            return [
                {"spanId": "seed-span", "name": "use_skill", "type": "TOOL"},
                {"spanId": "ranking-span", "name": "use_skill", "type": "TOOL"},
            ]

        def get_trace_span(self, _trace_id, span_id):
            names = {
                "seed-span": (
                    "fbradmin/seo-keyword-seed-generate",
                    "2026-09-02T07:00:00Z",
                    "2026-09-02T07:00:01Z",
                ),
                "ranking-span": (
                    "fbradmin/seo-keyword-ranking-optimize",
                    "2026-09-02T07:00:02Z",
                    "2026-09-02T07:00:03Z",
                ),
            }
            name, started_at, completed_at = names[span_id]
            return {
                "spanId": span_id,
                "name": "use_skill",
                "type": "TOOL",
                "status": "OK",
                "input": json.dumps({"name": name}),
                "output": "ToolCallResult{status=COMPLETED, toolName='use_skill'}",
                "startedAt": started_at,
                "completedAt": completed_at,
            }

        def trigger(self, agent_id, _input_text):
            self.triggered.append(agent_id)
            raise AssertionError("keyword-only regeneration must not launch downstream Agents")

    fake = CompletedSkillRun()
    seo_targets.poll_seo_targets_once(
        fake,
        seo_targets.SeoAgentIds("keyword-skill-agent", "", ""),
    )

    state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
    assert state["cycle_status"] == "ready"
    assert state["audit_report"] is None
    assert state["ranking_report"] is None
    assert state["local_falcon_cohort_sha256"] is not None
    assert state["capabilities"]["can_approve_local_falcon"] is True
    assert state["capabilities"]["can_generate_local_falcon"] is True
    assert fake.triggered == []
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    provenance = json.loads(
        conn.execute(
            "SELECT provenance_json FROM merchant_seo_artifacts"
            " WHERE merchant_id = ? AND coreai_run_id = 'verified-skill-only-run'",
            (merchant_id,),
        ).fetchone()[0]
    )
    conn.close()
    assert provenance["status"] == "VERIFIED"
    assert [item["qualified_name"] for item in provenance["skill_instruction_loads"]] == [
        "fbradmin/seo-keyword-seed-generate",
        "fbradmin/seo-keyword-ranking-optimize",
    ]
    lineage = provenance["workflow_lineage"]
    assert lineage["ranking_output_sha256"] == seo_targets._sha256_json(
        lineage["source_ranking_output"]
    )
    assert lineage["ranking_output_sha256"] != provenance["artifact_sha256"]
    assert lineage["adapter_version"] == (
        "seo_ops.ranking_skill_keyword_set_adapter.v2"
    )
    assert lineage["adapter_output_sha256"] == provenance[
        "artifact_sha256"
    ]


def test_skill_regeneration_rejects_a_legacy_direct_keyword_set_even_with_valid_skill_load_spans(
    client, monkeypatch
):
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    conn = seo_targets.connect()
    merchant = seo_targets.fetch_merchant(conn, merchant_id)
    request = seo_targets.build_keyword_request(conn, merchant)
    request["execution_spec"]["action"] = "REGENERATE_KEYWORD_SET_WITH_SKILLS"
    request["output_schema_version"] = "seo_ops.keyword_workflow_result.v1"
    request["workflow"] = {
        "seed_skill_id": "seed-skill",
        "ranking_skill_id": "ranking-skill",
        "seed_skill": {
            "id": "seed-skill",
            "qualified_name": "fbradmin/seo-keyword-seed-generate",
        },
        "ranking_skill": {
            "id": "ranking-skill",
            "qualified_name": "fbradmin/seo-keyword-ranking-optimize",
        },
        "stages": ["SEED", "RANK_AND_PRIORITIZE"],
        "result_schema_version": "seo_ops.keyword_workflow_result.v1",
    }
    seo_targets._insert_running_artifact(
        conn,
        merchant_id=merchant_id,
        cycle_id="legacy-direct-output",
        artifact_type="KEYWORD_SET",
        schema_version="seo_ops.keyword_set.v2",
        agent_id="keyword-skill-agent",
        run_id="legacy-direct-run",
        request=request,
    )
    conn.commit()
    conn.close()

    direct_keyword_set = mark_deterministic_local_ranks(
        keyword_result(
            merchant_id,
            [local_keyword("breakfast upper west side", score=95, priority="P0")],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
    )

    class LegacyDirectRunWithValidLoads:
        def get_run(self, _run_id):
            return {
                "status": "COMPLETED",
                "output": json.dumps(direct_keyword_set),
                "completed_at": "2026-09-02T07:00:04Z",
                "trace_id": "legacy-direct-trace",
            }

        def get_trace(self, trace_id):
            return {
                "traceId": trace_id,
                "agentId": "keyword-skill-agent",
                "status": "COMPLETED",
            }

        def list_trace_spans(self, _trace_id):
            return [
                {"spanId": "seed-span", "name": "use_skill", "type": "TOOL"},
                {"spanId": "ranking-span", "name": "use_skill", "type": "TOOL"},
            ]

        def get_trace_span(self, _trace_id, span_id):
            name, started, completed = {
                "seed-span": (
                    "fbradmin/seo-keyword-seed-generate",
                    "2026-09-02T07:00:00Z",
                    "2026-09-02T07:00:01Z",
                ),
                "ranking-span": (
                    "fbradmin/seo-keyword-ranking-optimize",
                    "2026-09-02T07:00:02Z",
                    "2026-09-02T07:00:03Z",
                ),
            }[span_id]
            return {
                "spanId": span_id,
                "name": "use_skill",
                "type": "TOOL",
                "status": "OK",
                "input": json.dumps({"name": name}),
                "output": "ToolCallResult{status=COMPLETED, toolName='use_skill'}",
                "startedAt": started,
                "completedAt": completed,
            }

    seo_targets.poll_seo_targets_once(
        LegacyDirectRunWithValidLoads(),
        seo_targets.SeoAgentIds("keyword-skill-agent", "", ""),
    )

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    row = conn.execute(
        "SELECT status, payload_json, provenance_json, error"
        " FROM merchant_seo_artifacts WHERE cycle_id = 'legacy-direct-output'"
    ).fetchone()
    conn.close()
    assert row[0] == "failed"
    assert row[1] is None
    assert row[2] is None
    assert "keyword_workflow_result" in row[3]


def test_failed_workflow_state_hides_raw_pydantic_validation_details(
    client, monkeypatch
):
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    raw_error = (
        "23 validation errors for KeywordWorkflowResultV1\n"
        "ranking_output.schema_version Field required [type=missing]\n"
        "ranking_output.keywords.0.intent Input should be LOCAL [type=literal_error]\n"
        "https://errors.pydantic.dev/2.13/v/missing"
    )
    conn = seo_targets.connect()
    seo_targets._insert_failed_artifact(
        conn,
        merchant_id=merchant_id,
        cycle_id="incompatible-ranking-output",
        artifact_type="KEYWORD_SET",
        schema_version="seo_ops.keyword_set.v2",
        agent_id="keyword-skill-agent",
        request={"output_schema_version": "seo_ops.keyword_workflow_result.v1"},
        error=raw_error,
    )
    conn.commit()
    conn.close()

    response = client.get(f"/api/merchants/{merchant_id}/seo-targets")

    assert response.status_code == 200
    assert response.json()["cycle_status"] == "failed"
    assert response.json()["error"] == (
        "关键词生成结果格式不兼容；已保留上一次成功关键词。"
        "请重新生成，Local Falcon 未启动。"
    )
    assert "pydantic" not in response.json()["error"].lower()
    assert "validation errors" not in response.json()["error"].lower()


@pytest.mark.parametrize(
    "raw_error",
    [
        "keyword Google Business identity does not match the run request",
        "keyword location name does not match the run request",
    ],
)
def test_failed_workflow_state_hides_internal_location_mismatch_details(
    client,
    monkeypatch,
    raw_error,
):
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    conn = seo_targets.connect()
    seo_targets._insert_failed_artifact(
        conn,
        merchant_id=merchant_id,
        cycle_id="mismatched-ranking-output",
        artifact_type="KEYWORD_SET",
        schema_version="seo_ops.keyword_set.v2",
        agent_id="keyword-skill-agent",
        request={"output_schema_version": "seo_ops.keyword_workflow_result.v1"},
        error=raw_error,
    )
    conn.commit()
    conn.close()

    response = client.get(f"/api/merchants/{merchant_id}/seo-targets")

    assert response.status_code == 200
    assert response.json()["error"] == (
        "关键词结果与当前 GBP 门店不匹配；已拒绝该结果并保留上一次成功关键词。"
        "Local Falcon 未启动。"
    )
    assert raw_error not in response.json()["error"]


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
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (merchant_id, "saved-cycle", "KEYWORD_SET", "seo_ops.keyword_set.v2", "ready", KEYWORD_AGENT_ID,
             "saved-keyword-run", json.dumps({"place_id": TEST_PLACE_ID}), json.dumps(saved_keyword_set),
             "2026-09-02T06:00:00Z", "2026-09-02T06:01:00Z"),
            (merchant_id, "saved-cycle", "AUDIT_REPORT", "seo_ops.audit_report.v1", "ready", AUDIT_AGENT_ID,
             "saved-audit-run", "{}", json.dumps(saved_audit), "2026-09-02T06:02:00Z", "2026-09-02T06:03:00Z"),
            (merchant_id, "saved-cycle", "RANKING_REPORT", "seo_ops.ranking_report.v1", "ready", RANKING_AGENT_ID,
             "saved-ranking-run", "{}", json.dumps(saved_ranking), "2026-09-02T06:04:00Z", "2026-09-02T06:05:00Z"),
            (merchant_id, "refresh-cycle", "KEYWORD_SET", "seo_ops.keyword_set.v2", "running", KEYWORD_AGENT_ID,
             "refresh-keyword-run", json.dumps({"place_id": TEST_PLACE_ID}), None,
             "2026-09-02T07:00:00Z", None),
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


def insert_ready_keyword_set(
    merchant_id,
    *,
    scored=True,
    generation_method="PERSISTED_FBR_READBACK",
):
    keyword_set = {
        "schema_version": "seo_ops.keyword_set.v2",
        "merchant_id": str(merchant_id),
        "market": {
            "country_code": "US",
            "language": "en-US",
            "search_engine": "GOOGLE",
            "location_name": "Upper West Side, New York, NY",
        },
        "generation_method": generation_method,
        "title": "Choice UWS keyword set",
        "summary": "Accepted keyword set for Local Falcon synchronization.",
        "keywords": [
            {
                "keyword": "breakfast upper west side",
                "strategy": "LOCAL",
                "intent": "LOCAL",
                "priority": "P0" if scored else "UNSCORED",
                "score": 95 if scored else None,
                "score_rank": 1 if scored else None,
                "local_falcon_selected": scored,
                "rationale": "Confirmed local breakfast target.",
                "source_tags": ["GBP_LOCATION"],
                "target_surface_types": ["GBP"],
                "target_location": "Upper West Side, New York, NY",
            },
            {
                "keyword": "coffee near lincoln center",
                "strategy": "LOCAL",
                "intent": "LOCAL",
                "priority": "P1" if scored else "UNSCORED",
                "score": 88 if scored else None,
                "score_rank": 2 if scored else None,
                "local_falcon_selected": scored,
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
                "score": None,
                "score_rank": None,
                "local_falcon_selected": False,
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
        " 'ready', ?, ?, ?, '2026-09-02T08:00:00Z', '2026-09-02T08:01:00Z')",
        (
            merchant_id,
            "fbr-keyword-store",
            json.dumps(
                {
                    "source": "FBR_KEYWORD_STORE",
                    "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
                }
            ),
            json.dumps(keyword_set),
        ),
    )
    conn.commit()
    conn.close()


def insert_verified_skill_keyword_set(
    merchant_id,
    *,
    cycle_id="verified-skill-cycle",
    place_id=TEST_PLACE_ID,
    location_name=TEST_LOCATION_NAME,
    keyword="verified breakfast keyword",
):
    from app import seo_targets

    payload = mark_deterministic_local_ranks(
        keyword_result(
            merchant_id,
            [local_keyword(keyword, score=95, priority="P0")],
            generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
        )
    )
    payload["market"]["location_name"] = location_name
    for item in payload["keywords"]:
        item["target_location"] = location_name
    seed = {
        "id": "seed-skill",
        "qualified_name": "fbradmin/seo-keyword-seed-generate",
        "version": None,
        "updated_at": "2026-09-02T06:00:00Z",
    }
    ranking = {
        "id": "ranking-skill",
        "qualified_name": "fbradmin/seo-keyword-ranking-optimize",
        "version": None,
        "updated_at": "2026-09-02T06:00:00Z",
    }
    seed_output = {
        "schema_version": "seo_keyword_seed_output.v1",
        "place_id": place_id,
        "seeds": [{"keyword": "breakfast", "source": "GBP_CATEGORY", "confidence": 0.95}],
    }
    payload_sha256 = seo_targets._sha256_json(payload)
    seed_sha256 = seo_targets._sha256_json(seed_output)
    request = {
        "output_schema_version": "seo_ops.keyword_workflow_result.v1",
        "execution_spec": {
            "action": "REGENERATE_KEYWORD_SET_WITH_SKILLS",
            "google_business_id": place_id,
        },
        "workflow": {
            "seed_skill_id": seed["id"],
            "ranking_skill_id": ranking["id"],
            "seed_skill": seed,
            "ranking_skill": ranking,
            "stages": ["SEED", "RANK_AND_PRIORITIZE"],
        },
    }
    provenance = {
        "status": "VERIFIED",
        "method": "CORE_AI_SKILL_LOAD_TRACE_AND_WORKFLOW_LINEAGE_V2",
        "run_id": f"{cycle_id}-run",
        "trace_id": f"{cycle_id}-trace",
        "source_agent_id": "keyword-skill-agent",
        "expected_skills": [
            {"stage": "SEED", **seed},
            {"stage": "RANK_AND_PRIORITIZE", **ranking},
        ],
        "skill_instruction_loads": [
            {"span_id": "seed-span", "qualified_name": seed["qualified_name"]},
            {"span_id": "ranking-span", "qualified_name": ranking["qualified_name"]},
        ],
        "workflow_lineage": {
            "schema_version": "seo_ops.keyword_workflow_lineage.v2",
            "seed_output_sha256": seed_sha256,
            "source_seed_output": seed_output,
            "ranking_input_sha256": seed_sha256,
            "ranking_output_sha256": payload_sha256,
            "source_ranking_output": payload,
            "adapter_version": seo_targets.RANKING_SKILL_KEYWORD_SET_ADAPTER_VERSION,
            "adapter_output_sha256": payload_sha256,
            "artifact_sha256": payload_sha256,
        },
        "artifact_sha256": payload_sha256,
    }
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    cursor = conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " coreai_run_id, request_json, payload_json, provenance_json, created_at, completed_at)"
        " VALUES (?, ?, 'KEYWORD_SET', 'seo_ops.keyword_set.v2', 'ready', ?, ?, ?, ?, ?, ?, ?)",
        (
            merchant_id,
            cycle_id,
            "keyword-skill-agent",
            provenance["run_id"],
            json.dumps(request),
            json.dumps(payload),
            json.dumps(provenance),
            "2026-09-02T08:00:00Z",
            "2026-09-02T08:01:00Z",
        ),
    )
    conn.commit()
    artifact_id = cursor.lastrowid
    conn.close()
    return artifact_id


def insert_unscored_fbr_keyword_inventory(
    merchant_id,
    *,
    cycle_id="newer-fbr-inventory",
    keyword="new unscored inventory keyword",
):
    payload = keyword_result(
        merchant_id,
        [local_keyword(keyword)],
        generation_method="PERSISTED_FBR_READBACK",
    )
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    cursor = conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " request_json, payload_json, created_at, completed_at)"
        " VALUES (?, ?, 'KEYWORD_SET', 'seo_ops.keyword_set.v2', 'ready',"
        " 'fbr-keyword-store', ?, ?, '2026-09-02T10:00:00Z', '2026-09-02T10:01:00Z')",
        (
            merchant_id,
            cycle_id,
            json.dumps({"source": "FBR_KEYWORD_STORE", "place_id": TEST_PLACE_ID}),
            json.dumps(payload),
        ),
    )
    conn.commit()
    artifact_id = cursor.lastrowid
    conn.close()
    return artifact_id


def test_state_prefers_newest_paid_keyword_artifact_for_the_current_location(
    client, monkeypatch
):
    merchant_id = create_uws_merchant(client, monkeypatch)
    monkeypatch.setenv("COREAI_LOCAL_FALCON_TOOL_ID", "local-falcon-tool")
    current_artifact_id = insert_verified_skill_keyword_set(merchant_id)
    insert_verified_skill_keyword_set(
        merchant_id,
        cycle_id="newer-other-location",
        place_id="other-place-id",
        location_name="Other location",
        keyword="wrong location keyword",
    )

    insert_unscored_fbr_keyword_inventory(
        merchant_id,
        keyword="unscored FBR inventory keyword",
    )

    response = client.get(f"/api/merchants/{merchant_id}/seo-targets")

    assert response.status_code == 200
    state = response.json()
    assert state["cycle_id"] == "newer-fbr-inventory"
    assert state["keyword_set_artifact_id"] == current_artifact_id
    assert [item["keyword"] for item in state["keyword_set"]["keywords"]] == [
        "verified breakfast keyword"
    ]
    assert state["local_falcon_cohort_sha256"] is not None
    assert state["capabilities"]["can_approve_local_falcon"] is True


def test_refresh_preserves_verified_scored_cohort_when_fbr_inventory_is_unscored(
    client, monkeypatch
):
    from app import fbr_gbp

    merchant_id = create_uws_merchant(client, monkeypatch)
    monkeypatch.setenv("COREAI_LOCAL_FALCON_TOOL_ID", "local-falcon-tool")
    current_artifact_id = insert_verified_skill_keyword_set(merchant_id)

    class UnscoredKeywordClient:
        def get_local_keywords(self, place_id):
            return {
                "place_id": place_id,
                "local_keywords": [
                    {
                        "local_keyword_id": "latest-fbr-inventory",
                        "keywords": [
                            {
                                "keyword": "new unscored inventory keyword",
                                "priority": "P1",
                                "target_surface_types": ["GBP"],
                            }
                        ],
                    }
                ],
            }

    monkeypatch.setattr(fbr_gbp, "fbr_gbp_client", lambda: UnscoredKeywordClient())

    response = client.post(f"/api/merchants/{merchant_id}/seo-targets/refresh")

    assert response.status_code == 202
    state = response.json()
    assert state["keyword_set_artifact_id"] == current_artifact_id
    assert state["keyword_set"]["keywords"][0]["keyword"] == "verified breakfast keyword"
    assert state["capabilities"]["can_approve_local_falcon"] is True

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    latest = conn.execute(
        "SELECT source_agent_id, status, payload_json FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? ORDER BY id DESC LIMIT 1",
        (merchant_id,),
    ).fetchone()
    conn.close()
    assert latest[0] == "fbr-keyword-store"
    assert latest[1] == "ready"
    assert json.loads(latest[2])["keywords"][0]["keyword"] == (
        "new unscored inventory keyword"
    )


def test_legacy_scored_evidence_bounded_artifact_cannot_form_a_paid_cohort(
    client, monkeypatch
):
    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(
        merchant_id,
        generation_method="EVIDENCE_BOUNDED_RESEARCH",
    )

    state = client.get(f"/api/merchants/{merchant_id}/seo-targets")

    assert state.status_code == 200
    assert state.json()["local_falcon_cohort_sha256"] is None
    assert state.json()["capabilities"]["can_approve_local_falcon"] is False


def test_forged_adapter_payload_without_skill_artifact_provenance_is_not_payable(
    client, monkeypatch
):
    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(
        merchant_id,
        generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
    )

    state = client.get(f"/api/merchants/{merchant_id}/seo-targets")

    assert state.status_code == 200
    assert state.json()["local_falcon_cohort_sha256"] is None
    assert state.json()["capabilities"]["can_approve_local_falcon"] is False


def test_legacy_v1_skill_artifact_cannot_form_the_paid_cohort(
    client, monkeypatch
):
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    for name, value in {
        "COREAI_KEYWORD_SKILL_AGENT_ID": "keyword-skill-agent",
        "COREAI_KEYWORD_SEED_SKILL_ID": "seed-skill",
        "COREAI_KEYWORD_RANKING_SKILL_ID": "ranking-skill",
    }.items():
        monkeypatch.setenv(name, value)
    insert_ready_keyword_set(
        merchant_id,
        generation_method="UPSTREAM_DETERMINISTIC_ADAPTER",
    )
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    row = conn.execute(
        "SELECT payload_json FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET'",
        (merchant_id,),
    ).fetchone()
    payload = json.loads(row[0])
    payload["market"]["location_name"] = "WRONG LOCATION"
    for item in payload["keywords"]:
        item["target_location"] = "WRONG LOCATION"
    seed = {
        "id": "seed-skill",
        "qualified_name": "fbradmin/seo-keyword-seed-generate",
        "version": None,
    }
    ranking = {
        "id": "ranking-skill",
        "qualified_name": "fbradmin/seo-keyword-ranking-optimize",
        "version": None,
    }
    provenance = {
        "status": "VERIFIED",
        "method": "CORE_AI_SKILL_LOAD_TRACE_AND_WORKFLOW_LINEAGE_V1",
        "run_id": "verified-keyword-run",
        "trace_id": "verified-trace",
        "source_agent_id": "keyword-skill-agent",
        "expected_skills": [
            {"stage": "SEED", **seed},
            {"stage": "RANK_AND_PRIORITIZE", **ranking},
        ],
        "skill_instruction_loads": [
            {"span_id": "seed-span", "qualified_name": seed["qualified_name"]},
            {"span_id": "ranking-span", "qualified_name": ranking["qualified_name"]},
        ],
        "artifact_sha256": seo_targets._sha256_json(payload),
        "workflow_lineage": {
            "schema_version": "seo_ops.keyword_workflow_lineage.v1",
            "seed_output_sha256": seo_targets._sha256_json({"seeds": ["breakfast"]}),
            "ranking_input_sha256": seo_targets._sha256_json({"seeds": ["breakfast"]}),
            "ranking_output_sha256": seo_targets._sha256_json(payload),
            "artifact_sha256": seo_targets._sha256_json(payload),
        },
    }
    conn.execute(
        "UPDATE merchant_seo_artifacts"
        " SET source_agent_id = ?, coreai_run_id = ?, payload_json = ?,"
        " request_json = ?, provenance_json = ?"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET'",
        (
            "keyword-skill-agent",
            "verified-keyword-run",
            json.dumps(payload),
            json.dumps(
                {
                    "output_schema_version": "seo_ops.keyword_workflow_result.v1",
                    "execution_spec": {
                        "action": "REGENERATE_KEYWORD_SET_WITH_SKILLS",
                        "google_business_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
                    },
                    "workflow": {
                        "seed_skill_id": "seed-skill",
                        "ranking_skill_id": "ranking-skill",
                        "seed_skill": seed,
                        "ranking_skill": ranking,
                        "stages": ["SEED", "RANK_AND_PRIORITIZE"],
                    },
                }
            ),
            json.dumps(provenance),
            merchant_id,
        ),
    )
    conn.commit()
    conn.close()

    state = client.get(f"/api/merchants/{merchant_id}/seo-targets")

    assert state.status_code == 200
    assert state.json()["local_falcon_cohort_sha256"] is None
    assert state.json()["capabilities"]["can_approve_local_falcon"] is False


def test_local_falcon_state_does_not_reuse_another_gbp_locations_data(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        synced = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
        state = synced.json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        )
        assert approved.status_code == 201

        conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
        row = conn.execute(
            "SELECT id, normalized_json FROM merchant_gbp_profiles WHERE merchant_id = ?",
            (merchant_id,),
        ).fetchone()
        next_location = json.loads(row[1])
        next_location["place_id"] = "ChIJ-DIFFERENT-LOCATION"
        conn.execute(
            "UPDATE merchant_gbp_profiles SET normalized_json = ? WHERE id = ?",
            (json.dumps(next_location), row[0]),
        )
        conn.commit()
        conn.close()

        switched = client.get(f"/api/merchants/{merchant_id}/seo-targets")
        stale_approval = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        )
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert switched.status_code == 200
    local_falcon = switched.json()["local_falcon"]
    assert local_falcon["status"] == "not_synced"
    assert local_falcon["reports"] == []
    assert local_falcon["scan_defaults"] is None
    assert local_falcon["approval"] is None
    assert switched.json()["capabilities"]["can_generate_local_falcon"] is False
    assert stale_approval.status_code == 409
    assert "another GBP location" in stale_approval.json()["detail"]


class FakeLocalFalcon:
    def __init__(self, fail=False):
        self.fail = fail
        self.listed_keywords = []
        self.scan_requests = []

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

    def run_scan(self, **request):
        self.scan_requests.append(request)
        return {
            "success": True,
            "message": "Scan submitted successfully",
            "report_key": f"{len(self.scan_requests):015x}",
        }


def test_local_falcon_approval_uses_scored_artifact_hidden_by_newer_fbr_inventory(
    client, monkeypatch
):
    merchant_id = create_uws_merchant(client, monkeypatch)
    scored_artifact_id = insert_verified_skill_keyword_set(merchant_id)
    insert_unscored_fbr_keyword_inventory(merchant_id)
    state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()

    response = client.post(
        f"/api/merchants/{merchant_id}/local-falcon-approvals",
        json={
            "keyword_artifact_id": scored_artifact_id,
            "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
        },
    )

    assert response.status_code == 201
    approval = response.json()["local_falcon"]["approval"]
    assert approval["keyword_artifact_id"] == scored_artifact_id
    assert approval["cohort_sha256"] == state["local_falcon_cohort_sha256"]
    assert [item["keyword"] for item in approval["cohort"]] == [
        "verified breakfast keyword"
    ]


def test_local_falcon_sync_uses_scored_artifact_hidden_by_newer_fbr_inventory(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    scored_artifact_id = insert_verified_skill_keyword_set(merchant_id)
    insert_unscored_fbr_keyword_inventory(merchant_id)

    class MissingReportLocalFalcon:
        def __init__(self):
            self.listed_keywords = []

        def list_latest_exact_report(self, place_id, keyword):
            assert place_id == TEST_PLACE_ID
            self.listed_keywords.append(keyword)
            return None

    fake = MissingReportLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        response = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert response.status_code == 200
    assert fake.listed_keywords == ["verified breakfast keyword"]
    assert response.json()["local_falcon"]["missing_keywords"] == [
        "verified breakfast keyword"
    ]
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    sync = conn.execute(
        "SELECT keyword_artifact_id, cohort_sha256, place_id"
        " FROM merchant_local_falcon_syncs WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    conn.close()
    assert sync == (
        scored_artifact_id,
        response.json()["local_falcon_cohort_sha256"],
        TEST_PLACE_ID,
    )


def test_local_falcon_scan_batch_keeps_exact_approved_scored_cohort_when_newer_fbr_inventory_is_unscored(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        synced = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
        assert synced.status_code == 200
        state = synced.json()
        scored_artifact_id = state["keyword_set_artifact_id"]
        approval_response = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": scored_artifact_id,
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        )
        assert approval_response.status_code == 201
        approval = approval_response.json()["local_falcon"]["approval"]
        insert_unscored_fbr_keyword_inventory(merchant_id)

        response = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approval["id"],
                "request_id": "preserved-scored-cohort-confirmation",
                "expected_scan_config_sha256": state["local_falcon"][
                    "scan_defaults_sha256"
                ],
                "confirm_credit_spend": True,
            },
        )
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert response.status_code == 202
    response_state = response.json()
    assert response_state["keyword_set_artifact_id"] == scored_artifact_id
    batch = response_state["local_falcon"]["scan_batch"]
    assert batch["approval_id"] == approval["id"]
    assert [item["keyword"] for item in batch["items"]] == [
        "breakfast upper west side",
        "coffee near lincoln center",
    ]
    assert fake.scan_requests == []

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    confirmation_row = conn.execute(
        "SELECT id, approval_id, confirmation_request_id, scan_config_sha256, confirmed_by"
        " FROM merchant_local_falcon_scan_confirmations WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    batch_row = conn.execute(
        "SELECT approval_id, confirmation_id FROM merchant_local_falcon_scan_batches"
        " WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    conn.close()
    assert confirmation_row[1:] == (
        approval["id"],
        "preserved-scored-cohort-confirmation",
        state["local_falcon"]["scan_defaults_sha256"],
        "test",
    )
    assert batch_row == (approval["id"], confirmation_row[0])


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


def test_local_falcon_scan_batch_requires_explicit_credit_confirmation(client, monkeypatch):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approval = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        )
        response = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approval.json()["local_falcon"]["approval"]["id"],
                "request_id": "approval-request-1",
                "expected_scan_config_sha256": "0" * 64,
                "confirm_credit_spend": False,
            },
        )
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert response.status_code == 409
    assert response.json()["detail"] == "confirm the credit-consuming Local Falcon scans"
    assert fake.scan_requests == []


def test_local_falcon_approval_rejects_a_stale_keyword_cohort(client, monkeypatch):
    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()

    response = client.post(
        f"/api/merchants/{merchant_id}/local-falcon-approvals",
        json={
            "keyword_artifact_id": state["keyword_set_artifact_id"],
            "expected_cohort_sha256": "0" * 64,
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "keyword cohort changed; review the latest Top 20"
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    count = conn.execute(
        "SELECT COUNT(*) FROM merchant_local_falcon_approvals WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()[0]
    conn.close()
    assert count == 0


def test_local_falcon_approval_waits_for_an_active_keyword_regeneration(client, monkeypatch):
    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " coreai_run_id, request_json, created_at)"
        " VALUES (?, 'new-keyword-cycle', 'KEYWORD_SET', 'seo_ops.keyword_set.v2',"
        " 'running', ?, 'new-keyword-run', '{}', '2026-09-02T09:00:00Z')",
        (merchant_id, KEYWORD_AGENT_ID),
    )
    conn.commit()
    conn.close()

    response = client.post(
        f"/api/merchants/{merchant_id}/local-falcon-approvals",
        json={
            "keyword_artifact_id": state["keyword_set_artifact_id"],
            "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "wait for keyword regeneration to finish before approval"


def test_local_falcon_scan_submits_the_scored_cohort_once_for_an_idempotency_key(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approval_response = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        )
        assert approval_response.status_code == 201
        approval = approval_response.json()["local_falcon"]["approval"]
        body = {
            "approval_id": approval["id"],
            "request_id": "approval-request-1",
            "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
            "confirm_credit_spend": True,
        }
        first = client.post(f"/api/merchants/{merchant_id}/local-falcon-scan-batches", json=body)
        assert first.json()["local_falcon"]["scan_batch"]["status"] == "submitting"
        assert fake.scan_requests == []
        assert seo_targets.submit_local_falcon_batches_once(fake) == 1
        second = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={**body, "request_id": "approval-request-2"},
        )
        repeated = client.post(f"/api/merchants/{merchant_id}/local-falcon-scan-batches", json=body)
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert first.status_code == 202
    assert second.status_code == 409
    assert "unresolved" in second.json()["detail"]
    assert repeated.status_code == 202
    assert first.json()["local_falcon"]["scan_batch"]["id"] == repeated.json()["local_falcon"]["scan_batch"]["id"]
    assert repeated.json()["local_falcon"]["scan_batch"]["status"] == "submitted"
    assert repeated.json()["local_falcon"]["scan_batch"]["submitted_count"] == 2
    assert [request["keyword"] for request in fake.scan_requests] == [
        "breakfast upper west side",
        "coffee near lincoln center",
    ]
    assert all(
        request
        == {
            "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
            "keyword": request["keyword"],
            "lat": 40.7771028,
            "lng": -73.9816854,
            "grid_size": 3,
            "radius": 0.5,
            "measurement": "km",
        }
        for request in fake.scan_requests
    )
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    confirmations = conn.execute(
        "SELECT id, confirmation_request_id, scan_config_sha256"
        " FROM merchant_local_falcon_scan_confirmations"
        " WHERE merchant_id = ? ORDER BY id",
        (merchant_id,),
    ).fetchall()
    batches = conn.execute(
        "SELECT confirmation_id FROM merchant_local_falcon_scan_batches"
        " WHERE merchant_id = ? ORDER BY id",
        (merchant_id,),
    ).fetchall()
    conn.close()
    assert [row[1] for row in confirmations] == ["approval-request-1"]
    assert all(row[2] == state["local_falcon"]["scan_defaults_sha256"] for row in confirmations)
    assert [row[0] for row in batches] == [row[0] for row in confirmations]


def test_local_falcon_scan_rejects_reusing_a_confirmation_request_for_other_parameters(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        body = {
            "approval_id": approved["local_falcon"]["approval"]["id"],
            "request_id": "frozen-confirmation-request",
            "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
            "confirm_credit_spend": True,
        }
        first = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches", json=body
        )
        assert seo_targets.submit_local_falcon_batches_once(fake) == 1
        conflicting = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={**body, "expected_scan_config_sha256": "0" * 64},
        )
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert first.status_code == 202
    assert conflicting.status_code == 409
    assert conflicting.json()["detail"] == (
        "request_id is already bound to another Local Falcon confirmation"
    )
    assert len(fake.scan_requests) == 2


def test_local_falcon_sync_completes_only_items_with_the_acknowledged_report_key(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)

    class CorrelatingLocalFalcon(FakeLocalFalcon):
        acknowledged_report_keys = {
            "breakfast upper west side": "111111111111111",
            "coffee near lincoln center": "222222222222222",
        }
        latest_report_keys = {
            "breakfast upper west side": "333333333333333",
            "coffee near lincoln center": "444444444444444",
        }

        def __init__(self):
            super().__init__()
            self.scans_submitted = False
            self.read_report_keys = []

        def run_scan(self, **request):
            self.scan_requests.append(request)
            self.scans_submitted = len(self.scan_requests) == 2
            return {
                "success": True,
                "message": "Scan submitted successfully",
                "report_key": self.acknowledged_report_keys[request["keyword"]],
            }

        def list_latest_exact_report(self, place_id, keyword):
            if not self.scans_submitted:
                return super().list_latest_exact_report(place_id, keyword)
            return {
                "report_key": self.latest_report_keys[keyword],
                "date": "9/2/2026 4:05 PM",
                "keyword": keyword,
                "platform": "google",
            }

        def get_report(self, report_key):
            self.read_report_keys.append(report_key)
            if report_key == "8aa3c7e1f6c599b":
                return super().get_report(report_key)
            keyword_by_report_key = {
                key: keyword
                for mapping in (self.acknowledged_report_keys, self.latest_report_keys)
                for keyword, key in mapping.items()
            }
            keyword = keyword_by_report_key[report_key]
            return {
                "report_key": report_key,
                "date": (
                    "9/2/2026 4:00 PM"
                    if report_key in self.acknowledged_report_keys.values()
                    else "9/2/2026 4:05 PM"
                ),
                "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
                "platform": "google",
                "keyword": keyword,
                "lat": "40.7771028",
                "lng": "-73.9816854",
                "grid_size": "3",
                "radius": "0.5",
                "measurement": "km",
                "arp": "2.0",
                "atrp": "2.0",
                "solv": "88.0",
                "found_in": "9",
                "data_points": [
                    {"lat": "40.2", "lng": "-73.2", "found": True, "rank": 2},
                    {"lat": "40.1", "lng": "-73.2", "found": True, "rank": 2},
                    {"lat": "40.0", "lng": "-73.2", "found": True, "rank": 2},
                    {"lat": "40.2", "lng": "-73.1", "found": True, "rank": 2},
                    {"lat": "40.1", "lng": "-73.1", "found": True, "rank": 2},
                    {"lat": "40.0", "lng": "-73.1", "found": True, "rank": 2},
                    {"lat": "40.2", "lng": "-73.0", "found": True, "rank": 2},
                    {"lat": "40.1", "lng": "-73.0", "found": True, "rank": 2},
                    {"lat": "40.0", "lng": "-73.0", "found": True, "rank": 2},
                ],
            }

    fake = CorrelatingLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        submitted = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "correlated-readback-request",
                "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
                "confirm_credit_spend": True,
            },
        )
        assert seo_targets.submit_local_falcon_batches_once(fake) == 1
        synced = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert submitted.status_code == 202
    assert submitted.json()["local_falcon"]["scan_batch"]["status"] == "submitting"
    assert synced.status_code == 200
    batch = synced.json()["local_falcon"]["scan_batch"]
    assert batch["status"] == "completed"
    assert batch["completed_count"] == 2
    assert all(item["status"] == "completed" for item in batch["items"])
    assert set(fake.acknowledged_report_keys.values()).issubset(fake.read_report_keys)
    assert set(fake.latest_report_keys.values()).issubset(fake.read_report_keys)


def test_local_falcon_scan_does_not_retry_an_uncertain_paid_submission(client, monkeypatch):
    from app.main import app
    from app import seo_targets
    from app.coreai import CoreAiError

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)

    class UncertainLocalFalcon(FakeLocalFalcon):
        def run_scan(self, **request):
            self.scan_requests.append(request)
            raise CoreAiError(0, "connection closed after submission")

    fake = UncertainLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        body = {
            "approval_id": approved["local_falcon"]["approval"]["id"],
            "request_id": "uncertain-request-1",
            "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
            "confirm_credit_spend": True,
        }
        first = client.post(f"/api/merchants/{merchant_id}/local-falcon-scan-batches", json=body)
        assert seo_targets.submit_local_falcon_batches_once(fake) == 1
        repeated = client.post(f"/api/merchants/{merchant_id}/local-falcon-scan-batches", json=body)
        changed_request = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={**body, "request_id": "uncertain-request-2"},
        )
        refresh = client.post(f"/api/merchants/{merchant_id}/seo-targets/refresh")
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert first.status_code == 202
    assert repeated.status_code == 202
    assert changed_request.status_code == 409
    assert "unresolved" in changed_request.json()["detail"]
    assert refresh.status_code == 409
    assert "unresolved" in refresh.json()["detail"]
    batch = repeated.json()["local_falcon"]["scan_batch"]
    assert batch["status"] == "unknown"
    assert batch["unknown_count"] == 1
    assert batch["submitted_count"] == 0
    assert len(fake.scan_requests) == 1


def test_stale_local_falcon_worker_cannot_overwrite_unknown_or_submit_more_items(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)

    class StaleDuringFirstSubmission(FakeLocalFalcon):
        def run_scan(self, **request):
            self.scan_requests.append(request)
            stale = sqlite3.connect(os.environ["SEO_OPS_DB"])
            stale.row_factory = sqlite3.Row
            stale.execute(
                "UPDATE merchant_local_falcon_scan_batches"
                " SET dispatch_started_at = '2020-01-01T00:00:00+00:00'"
            )
            stale.commit()
            seo_targets._mark_stale_local_falcon_dispatches_unknown(stale)
            stale.close()
            return {
                "success": True,
                "message": "late acknowledgement after lease expiry",
                "report_key": "111111111111111",
            }

    fake = StaleDuringFirstSubmission()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        created = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "stale-worker-request",
                "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
                "confirm_credit_spend": True,
            },
        )
        assert created.status_code == 202
        assert seo_targets.submit_local_falcon_batches_once(fake) == 1
        latest = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    batch = latest["local_falcon"]["scan_batch"]
    assert batch["status"] == "unknown"
    assert batch["unknown_count"] == 1
    assert batch["pending_count"] == 1
    assert batch["submitted_count"] == 0
    assert len(fake.scan_requests) == 1


def test_stale_local_falcon_recovery_preserves_a_batch_heartbeated_after_candidate_read(
    client, monkeypatch
):
    """A stale snapshot must not expire a worker whose lease was just renewed."""
    from app import seo_targets

    merchant_id = client.post(
        "/api/merchants",
        json={"name": "heartbeat race", "primary_location": "Mineola, NY"},
    ).json()["id"]
    setup = sqlite3.connect(os.environ["SEO_OPS_DB"])
    cursor = setup.execute(
        "INSERT INTO merchant_local_falcon_scan_batches"
        " (merchant_id, approval_id, confirmation_id, request_id, status,"
        " scan_config_json, dispatch_token, dispatch_started_at, created_at)"
        " VALUES (?, 991, 992, 'heartbeat-race', 'submitting', '{}',"
        " 'active-worker-token', '2020-01-01T00:00:00+00:00',"
        " '2020-01-01T00:00:00+00:00')",
        (merchant_id,),
    )
    batch_id = cursor.lastrowid
    setup.execute(
        "INSERT INTO merchant_local_falcon_scan_items"
        " (batch_id, keyword, status, updated_at)"
        " VALUES (?, 'breakfast near me', 'submitting',"
        " '2020-01-01T00:00:00+00:00')",
        (batch_id,),
    )
    setup.commit()
    setup.close()

    real_now_iso = seo_targets.now_iso
    heartbeat_written = False

    def heartbeat_between_candidate_read_and_transition():
        nonlocal heartbeat_written
        if not heartbeat_written:
            heartbeat_written = True
            worker = sqlite3.connect(os.environ["SEO_OPS_DB"])
            worker.execute(
                "UPDATE merchant_local_falcon_scan_batches"
                " SET dispatch_started_at = '2099-01-01T00:00:00+00:00'"
                " WHERE id = ? AND status = 'submitting'"
                " AND dispatch_token = 'active-worker-token'",
                (batch_id,),
            )
            worker.commit()
            worker.close()
        return real_now_iso()

    monkeypatch.setattr(
        seo_targets,
        "now_iso",
        heartbeat_between_candidate_read_and_transition,
    )
    recovery = sqlite3.connect(os.environ["SEO_OPS_DB"])
    recovery.row_factory = sqlite3.Row
    seo_targets._mark_stale_local_falcon_dispatches_unknown(recovery)
    recovery.close()

    check = sqlite3.connect(os.environ["SEO_OPS_DB"])
    batch = check.execute(
        "SELECT status, dispatch_token, dispatch_started_at"
        " FROM merchant_local_falcon_scan_batches WHERE id = ?",
        (batch_id,),
    ).fetchone()
    item_status = check.execute(
        "SELECT status FROM merchant_local_falcon_scan_items WHERE batch_id = ?",
        (batch_id,),
    ).fetchone()[0]
    check.close()

    assert heartbeat_written is True
    assert batch == (
        "submitting",
        "active-worker-token",
        "2099-01-01T00:00:00+00:00",
    )
    assert item_status == "submitting"


def test_operator_can_bind_an_exact_unknown_report_then_close_remaining_without_retry(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)

    class ReconciliationLocalFalcon(FakeLocalFalcon):
        def get_report(self, report_key):
            report = super().get_report(report_key)
            report["date"] = "2026-09-02T16:05:00+00:00"
            return report

    fake = ReconciliationLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    app.dependency_overrides[seo_targets.get_reconciliation_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        created = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "manual-reconciliation-request",
                "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
                "confirm_credit_spend": True,
            },
        ).json()
        batch_id = created["local_falcon"]["scan_batch"]["id"]
        conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
        first_item = conn.execute(
            "SELECT id FROM merchant_local_falcon_scan_items"
            " WHERE batch_id = ? ORDER BY id LIMIT 1",
            (batch_id,),
        ).fetchone()[0]
        conn.execute(
            "UPDATE merchant_local_falcon_scan_batches"
            " SET status = 'unknown', created_at = '2026-09-02T15:00:00+00:00'"
            " WHERE id = ?",
            (batch_id,),
        )
        conn.execute(
            "UPDATE merchant_local_falcon_scan_items SET status = 'unknown' WHERE id = ?",
            (first_item,),
        )
        conn.commit()
        conn.close()

        reconciliation_body = {
            "action": "BIND_ACKNOWLEDGED_REPORT",
            "keyword": "breakfast upper west side",
            "report_key": "8aa3c7e1f6c599b",
            "reason": "Matched the exact Local Falcon acknowledgement in the operator log.",
        }
        blocked = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches/{batch_id}/reconcile",
            json=reconciliation_body,
        )
        assert blocked.status_code == 409
        assert "correlation id" in blocked.json()["detail"]

        # Preserve coverage for the guarded future path without advertising it
        # to operators under the current upstream contract.
        monkeypatch.setattr(
            seo_targets,
            "LOCAL_FALCON_MANUAL_REPORT_BINDING_ENABLED",
            True,
        )
        bound = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches/{batch_id}/reconcile",
            json=reconciliation_body,
        )
        closed = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches/{batch_id}/reconcile",
            json={
                "action": "CLOSE_WITHOUT_RETRY",
                "reason": "Leave the remaining unsubmitted keyword for a separately approved batch.",
            },
        )
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)
        app.dependency_overrides.pop(seo_targets.get_reconciliation_local_falcon, None)

    assert bound.status_code == 200
    bound_batch = bound.json()["local_falcon"]["scan_batch"]
    assert bound_batch["status"] == "partial"
    assert bound_batch["completed_count"] == 1
    assert bound_batch["unknown_count"] == 0
    assert bound_batch["pending_count"] == 1
    assert closed.status_code == 200
    closed_batch = closed.json()["local_falcon"]["scan_batch"]
    assert closed_batch["status"] == "failed"
    assert closed_batch["completed_count"] == 1
    assert closed_batch["failed_count"] == 1
    assert closed_batch["needs_reconciliation"] is False

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    actions = conn.execute(
        "SELECT action FROM merchant_local_falcon_reconciliations"
        " WHERE batch_id = ? ORDER BY id",
        (batch_id,),
    ).fetchall()
    conn.close()
    assert [row[0] for row in actions] == [
        "BIND_ACKNOWLEDGED_REPORT",
        "CLOSE_WITHOUT_RETRY",
    ]


def test_reconciliation_rejects_a_report_timestamp_without_timezone():
    from fastapi import HTTPException
    from app import seo_targets

    with pytest.raises(HTTPException) as exc_info:
        seo_targets._verified_reconciliation_report_time("9/2/2026 4:05 PM")

    assert exc_info.value.status_code == 409
    assert "timezone" in str(exc_info.value.detail).lower()


def test_confirm_not_submitted_closes_unknown_batch_without_remote_retry(client, monkeypatch):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        created = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "confirmed-not-submitted-request",
                "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
                "confirm_credit_spend": True,
            },
        ).json()
        batch_id = created["local_falcon"]["scan_batch"]["id"]
        conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
        conn.execute(
            "UPDATE merchant_local_falcon_scan_batches SET status = 'unknown' WHERE id = ?",
            (batch_id,),
        )
        conn.execute(
            "UPDATE merchant_local_falcon_scan_items SET status = 'unknown'"
            " WHERE id = (SELECT id FROM merchant_local_falcon_scan_items"
            " WHERE batch_id = ? ORDER BY id LIMIT 1)",
            (batch_id,),
        )
        conn.commit()
        conn.close()

        response = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches/{batch_id}/reconcile",
            json={
                "action": "CONFIRM_NOT_SUBMITTED",
                "reason": "Local Falcon billing and report history both confirm no request was accepted.",
            },
        )
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert response.status_code == 200
    batch = response.json()["local_falcon"]["scan_batch"]
    assert batch["status"] == "failed"
    assert batch["failed_count"] == 2
    assert fake.scan_requests == []


def test_confirm_not_submitted_closes_an_unclaimed_queued_batch_without_integration(
    client, monkeypatch
):
    """Catch regressions that strand a durable batch before any worker claims it."""
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        created = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "unclaimed-confirmed-not-submitted",
                "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
                "confirm_credit_spend": True,
            },
        )
        batch = created.json()["local_falcon"]["scan_batch"]
        assert batch["status"] == "submitting"
        assert batch["pending_count"] == batch["total_count"] == 2
        assert batch["submitting_count"] == 0
        assert batch["needs_reconciliation"] is False
        assert batch["can_confirm_not_submitted"] is True
        assert batch["can_bind_acknowledged_report"] is False
        assert "关联 ID" in batch["report_binding_blocker"]

        app.dependency_overrides[seo_targets.get_reconciliation_local_falcon] = lambda: None
        response = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches/{batch['id']}/reconcile",
            json={
                "action": "CONFIRM_NOT_SUBMITTED",
                "reason": "Worker queue inspection confirms this batch was never claimed or submitted.",
            },
        )
        assert seo_targets.submit_local_falcon_batches_once(fake) == 0
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)
        app.dependency_overrides.pop(seo_targets.get_reconciliation_local_falcon, None)

    assert response.status_code == 200
    closed = response.json()["local_falcon"]["scan_batch"]
    assert closed["status"] == "failed"
    assert closed["failed_count"] == 2
    assert closed["needs_reconciliation"] is False
    assert closed["can_confirm_not_submitted"] is False
    assert fake.scan_requests == []

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    audit = conn.execute(
        "SELECT action, reason, details_json FROM merchant_local_falcon_reconciliations"
        " WHERE batch_id = ? ORDER BY id",
        (batch["id"],),
    ).fetchall()
    conn.close()
    assert [(row[0], row[1]) for row in audit] == [
        (
            "CONFIRM_NOT_SUBMITTED",
            "Worker queue inspection confirms this batch was never claimed or submitted.",
        )
    ]
    assert json.loads(audit[0][2])["automatic_retry"] is False


def test_confirm_not_submitted_rechecks_the_queue_claim_inside_its_write_lock(
    client, monkeypatch
):
    """Catch a worker claim winning after the HTTP preflight but before reconciliation."""
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    app.dependency_overrides[seo_targets.get_reconciliation_local_falcon] = lambda: None
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        created = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "queue-claim-race",
                "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
                "confirm_credit_spend": True,
            },
        ).json()
        batch_id = created["local_falcon"]["scan_batch"]["id"]

        claim_injected = False

        def now_with_worker_claim():
            nonlocal claim_injected
            if not claim_injected:
                claim_injected = True
                worker = sqlite3.connect(os.environ["SEO_OPS_DB"])
                worker.execute("BEGIN IMMEDIATE")
                worker.execute(
                    "UPDATE merchant_local_falcon_scan_batches"
                    " SET dispatch_token = 'worker-won-race',"
                    " dispatch_started_at = '2026-09-02T10:00:00+00:00'"
                    " WHERE id = ? AND status = 'submitting' AND dispatch_token IS NULL",
                    (batch_id,),
                )
                worker.commit()
                worker.close()
            return "2026-09-02T10:00:01+00:00"

        monkeypatch.setattr(seo_targets, "now_iso", now_with_worker_claim)
        response = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches/{batch_id}/reconcile",
            json={
                "action": "CONFIRM_NOT_SUBMITTED",
                "reason": "Queue inspection initially showed no claim, then the worker acquired it.",
            },
        )
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)
        app.dependency_overrides.pop(seo_targets.get_reconciliation_local_falcon, None)

    assert response.status_code == 409
    assert "claimed or changed" in response.json()["detail"]
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    batch = conn.execute(
        "SELECT status, dispatch_token FROM merchant_local_falcon_scan_batches WHERE id = ?",
        (batch_id,),
    ).fetchone()
    items = conn.execute(
        "SELECT status FROM merchant_local_falcon_scan_items WHERE batch_id = ? ORDER BY id",
        (batch_id,),
    ).fetchall()
    audits = conn.execute(
        "SELECT COUNT(*) FROM merchant_local_falcon_reconciliations WHERE batch_id = ?",
        (batch_id,),
    ).fetchone()[0]
    conn.close()
    assert batch == ("submitting", "worker-won-race")
    assert [row[0] for row in items] == ["pending", "pending"]
    assert audits == 0
    assert fake.scan_requests == []


@pytest.mark.parametrize(
    ("first_report_mode", "expected_error"),
    [
        ("not_ready", "Local Falcon acknowledged report is not ready"),
        ("malformed", "Local Falcon data_points are missing"),
    ],
)
def test_acknowledged_report_readback_persists_each_success_and_isolates_failures(
    client, monkeypatch, first_report_mode, expected_error
):
    """Catch all-or-nothing readback that loses 19 ready reports behind one bad report."""
    from app.main import app
    from app import seo_targets
    from app.coreai import CoreAiError

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)

    class PartiallyReadyLocalFalcon(FakeLocalFalcon):
        def __init__(self):
            super().__init__()
            self.scans_submitted = False
            self.read_report_keys = []

        def run_scan(self, **request):
            result = super().run_scan(**request)
            self.scans_submitted = len(self.scan_requests) == 2
            return result

        def list_latest_exact_report(self, place_id, keyword):
            if not self.scans_submitted:
                return super().list_latest_exact_report(place_id, keyword)
            self.listed_keywords.append(keyword)
            return None

        def get_report(self, report_key):
            if not self.scans_submitted or report_key == "8aa3c7e1f6c599b":
                return super().get_report(report_key)
            self.read_report_keys.append(report_key)
            if report_key == "000000000000001":
                if first_report_mode == "not_ready":
                    raise CoreAiError(404, "Local Falcon acknowledged report is not ready")
                return {"report_key": report_key}
            report = super().get_report("8aa3c7e1f6c599b")
            report.update(
                {
                    "report_key": report_key,
                    "keyword": "coffee near lincoln center",
                    "date": "9/2/2026 4:05 PM",
                }
            )
            return report

    fake = PartiallyReadyLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        created = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "partially-ready-readback",
                "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
                "confirm_credit_spend": True,
            },
        )
        assert created.status_code == 202
        assert seo_targets.submit_local_falcon_batches_once(fake) == 1
        scan_count = len(fake.scan_requests)
        synced = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert synced.status_code == 200
    batch = synced.json()["local_falcon"]["scan_batch"]
    assert batch["status"] == "submitted"
    assert batch["submitted_count"] == 1
    assert batch["completed_count"] == 1
    failed_readback = next(
        item for item in batch["items"] if item["keyword"] == "breakfast upper west side"
    )
    completed_readback = next(
        item for item in batch["items"] if item["keyword"] == "coffee near lincoln center"
    )
    assert failed_readback["status"] == "submitted"
    assert failed_readback["error"] == expected_error
    assert completed_readback["status"] == "completed"
    assert completed_readback["error"] is None
    assert fake.read_report_keys == ["000000000000001", "000000000000002"]
    assert len(fake.scan_requests) == scan_count == 2

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    persisted = conn.execute(
        "SELECT report_key, keyword FROM merchant_local_falcon_reports"
        " WHERE merchant_id = ? AND report_key = ?",
        (merchant_id, "000000000000002"),
    ).fetchone()
    conn.close()
    assert persisted == ("000000000000002", "coffee near lincoln center")


@pytest.mark.parametrize(
    ("report_mode", "expected_error"),
    [
        ("not_ready", "Local Falcon acknowledged report is not ready"),
        ("malformed", "Local Falcon data_points are missing"),
    ],
)
def test_background_ack_report_poll_only_records_readback_errors_without_resubmitting(
    client, report_mode, expected_error
):
    from app import seo_targets
    from app.coreai import CoreAiError

    merchant_id = client.post(
        "/api/merchants",
        json={
            "name": "background acknowledgement",
            "primary_location": "Mineola, NY",
        },
    ).json()["id"]
    scan_config = {
        "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
        "platform": "google",
        "lat": 40.7771028,
        "lng": -73.9816854,
        "grid_size": 3,
        "radius": 0.5,
        "measurement": "km",
    }
    setup = sqlite3.connect(os.environ["SEO_OPS_DB"])
    batch_id = setup.execute(
        "INSERT INTO merchant_local_falcon_scan_batches"
        " (merchant_id, approval_id, confirmation_id, request_id, status,"
        " scan_config_json, created_at)"
        " VALUES (?, 971, 972, 'background-ack', 'submitted', ?,"
        " '2026-09-02T10:00:00+00:00')",
        (merchant_id, json.dumps(scan_config)),
    ).lastrowid
    setup.execute(
        "INSERT INTO merchant_local_falcon_scan_items"
        " (batch_id, keyword, status, ack_report_key, updated_at)"
        " VALUES (?, 'breakfast upper west side', 'submitted',"
        " '8aa3c7e1f6c599b', '2026-09-02T10:00:00+00:00')",
        (batch_id,),
    )
    setup.commit()
    setup.close()

    class ReadOnlyFailure(FakeLocalFalcon):
        def run_scan(self, **_request):
            raise AssertionError("ack report polling must never submit or retry a paid scan")

        def get_report(self, report_key):
            if report_mode == "not_ready":
                raise CoreAiError(404, "Local Falcon acknowledged report is not ready")
            return {"report_key": report_key}

    processed = seo_targets.poll_acknowledged_local_falcon_reports_once(
        ReadOnlyFailure()
    )

    check = sqlite3.connect(os.environ["SEO_OPS_DB"])
    item = check.execute(
        "SELECT status, ack_report_key, error"
        " FROM merchant_local_falcon_scan_items WHERE batch_id = ?",
        (batch_id,),
    ).fetchone()
    batch_status = check.execute(
        "SELECT status FROM merchant_local_falcon_scan_batches WHERE id = ?",
        (batch_id,),
    ).fetchone()[0]
    report_count = check.execute(
        "SELECT COUNT(*) FROM merchant_local_falcon_reports WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()[0]
    check.close()

    assert processed == 1
    assert item == ("submitted", "8aa3c7e1f6c599b", expected_error)
    assert batch_status == "submitted"
    assert report_count == 0


def test_background_ack_report_poll_persists_ready_report_and_completes_batch(client):
    from app import seo_targets

    merchant_id = client.post(
        "/api/merchants",
        json={
            "name": "ready acknowledgement",
            "primary_location": "Mineola, NY",
        },
    ).json()["id"]
    scan_config = {
        "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
        "platform": "google",
        "lat": 40.7771028,
        "lng": -73.9816854,
        "grid_size": 3,
        "radius": 0.5,
        "measurement": "km",
    }
    setup = sqlite3.connect(os.environ["SEO_OPS_DB"])
    batch_id = setup.execute(
        "INSERT INTO merchant_local_falcon_scan_batches"
        " (merchant_id, approval_id, confirmation_id, request_id, status,"
        " scan_config_json, created_at)"
        " VALUES (?, 961, 962, 'ready-background-ack', 'submitted', ?,"
        " '2026-09-02T10:00:00+00:00')",
        (merchant_id, json.dumps(scan_config)),
    ).lastrowid
    setup.execute(
        "INSERT INTO merchant_local_falcon_scan_items"
        " (batch_id, keyword, status, ack_report_key, updated_at)"
        " VALUES (?, 'breakfast upper west side', 'submitted',"
        " '8aa3c7e1f6c599b', '2026-09-02T10:00:00+00:00')",
        (batch_id,),
    )
    setup.commit()
    setup.close()
    fake = FakeLocalFalcon()

    processed = seo_targets.poll_acknowledged_local_falcon_reports_once(fake)

    check = sqlite3.connect(os.environ["SEO_OPS_DB"])
    item_status = check.execute(
        "SELECT status FROM merchant_local_falcon_scan_items WHERE batch_id = ?",
        (batch_id,),
    ).fetchone()[0]
    batch_status = check.execute(
        "SELECT status FROM merchant_local_falcon_scan_batches WHERE id = ?",
        (batch_id,),
    ).fetchone()[0]
    persisted = check.execute(
        "SELECT report_key FROM merchant_local_falcon_reports WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()[0]
    check.close()

    assert processed == 1
    assert fake.scan_requests == []
    assert item_status == "completed"
    assert batch_status == "completed"
    assert persisted == "8aa3c7e1f6c599b"


def test_keyword_refresh_claim_blocks_a_paid_batch_before_external_readback(
    client, monkeypatch
):
    from app.main import app
    from app import fbr_gbp, seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake

    entered_readback = threading.Event()
    release_readback = threading.Event()

    class BlockingKeywordReadback:
        def get_local_keywords(self, place_id):
            entered_readback.set()
            assert release_readback.wait(timeout=5)
            return {"place_id": place_id, "local_keywords": []}

    monkeypatch.setattr(fbr_gbp, "fbr_gbp_client", lambda: BlockingKeywordReadback())
    monkeypatch.setenv("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-agent")
    monkeypatch.setenv("COREAI_KEYWORD_SEED_SKILL_ID", "seed-skill")
    monkeypatch.setenv("COREAI_KEYWORD_RANKING_SKILL_ID", "ranking-skill")

    class WorkflowClient:
        def get_agent(self, agent_id):
            return {"id": agent_id, "skill_ids": ["seed-skill", "ranking-skill"]}

        def get_skill(self, skill_id):
            return {
                "id": skill_id,
                "qualified_name": (
                    "fbradmin/seo-keyword-seed-generate"
                    if skill_id == "seed-skill"
                    else "fbradmin/seo-keyword-ranking-optimize"
                ),
                "version": None,
            }

        def trigger(self, _agent_id, _input_text):
            return {"run_id": "refresh-claimed-run"}

    monkeypatch.setattr(seo_targets, "get_keyword_skill_workflow", lambda: (
        WorkflowClient(),
        seo_targets.KeywordSkillWorkflow(
            "keyword-skill-agent", "seed-skill", "ranking-skill"
        ),
    ))

    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        result = {}

        def refresh_in_background():
            result["response"] = client.post(
                f"/api/merchants/{merchant_id}/seo-targets/refresh"
            )

        thread = threading.Thread(target=refresh_in_background)
        thread.start()
        assert entered_readback.wait(timeout=5)
        scan = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "blocked-by-refresh-claim",
                "expected_scan_config_sha256": state["local_falcon"]["scan_defaults_sha256"],
                "confirm_credit_spend": True,
            },
        )
        release_readback.set()
        thread.join(timeout=5)
    finally:
        release_readback.set()
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert scan.status_code == 409
    assert "keyword regeneration" in scan.json()["detail"]
    assert fake.scan_requests == []
    assert result["response"].status_code == 409
    assert result["response"].json()["detail"] == (
        "FBR has no persisted keywords for this GBP location; "
        "use the explicit regenerate action to create a new scored set"
    )


def test_local_falcon_scan_rejects_parameters_that_changed_after_confirmation(client, monkeypatch):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
        state = client.get(f"/api/merchants/{merchant_id}/seo-targets").json()
        approved = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-approvals",
            json={
                "keyword_artifact_id": state["keyword_set_artifact_id"],
                "expected_cohort_sha256": state["local_falcon_cohort_sha256"],
            },
        ).json()
        confirmed_hash = state["local_falcon"]["scan_defaults_sha256"]
        conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
        conn.execute(
            "UPDATE merchant_local_falcon_reports SET radius = 1.0 WHERE merchant_id = ?",
            (merchant_id,),
        )
        conn.commit()
        conn.close()

        response = client.post(
            f"/api/merchants/{merchant_id}/local-falcon-scan-batches",
            json={
                "approval_id": approved["local_falcon"]["approval"]["id"],
                "request_id": "changed-parameters-request",
                "expected_scan_config_sha256": confirmed_hash,
                "confirm_credit_spend": True,
            },
        )
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert response.status_code == 409
    assert response.json()["detail"] == "scan parameters changed; review the latest settings"
    assert fake.scan_requests == []


def test_local_falcon_sync_rejects_an_unscored_keyword_set_instead_of_syncing_every_keyword(
    client, monkeypatch
):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id, scored=False)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        response = client.post(f"/api/merchants/{merchant_id}/local-falcon-sync")
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    assert response.status_code == 409
    assert response.json()["detail"] == (
        "keyword scores are required before selecting the Local Falcon Top 20 cohort"
    )
    assert fake.listed_keywords == []


def test_unscored_keywords_keep_existing_local_falcon_reports_visible(client, monkeypatch):
    from app.main import app
    from app import seo_targets

    merchant_id = create_uws_merchant(client, monkeypatch)
    insert_ready_keyword_set(merchant_id)
    fake = FakeLocalFalcon()
    app.dependency_overrides[seo_targets.get_local_falcon] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant_id}/local-falcon-sync").status_code == 200
    finally:
        app.dependency_overrides.pop(seo_targets.get_local_falcon, None)

    insert_ready_keyword_set(merchant_id, scored=False)
    state = client.get(f"/api/merchants/{merchant_id}/seo-targets")

    assert state.status_code == 200
    assert state.json()["capabilities"]["can_sync_local_falcon"] is False
    assert state.json()["local_falcon"]["reports"][0]["report_key"] == "8aa3c7e1f6c599b"


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
