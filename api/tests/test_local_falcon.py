import json

import httpx
import pytest


def make_local_falcon(handler):
    from app.coreai import CoreAiClient
    from app.local_falcon import LocalFalconClient

    core = CoreAiClient("https://core.test", "coreai_k", transport=httpx.MockTransport(handler))
    return LocalFalconClient(core, "local-falcon-id")


def test_list_latest_exact_report_ignores_loose_keyword_matches():
    def handler(request):
        body = json.loads(request.content)
        assert body["tool_name"] == "listLocalFalconScanReports"
        assert json.loads(body["arguments"]) == {
            "placeId": "place-1",
            "keyword": "Breakfast Upper West Side",
            "platform": "google",
            "fieldmask": (
                "report_key,date,place_id,keyword,platform,arp,atrp,solv,"
                "grid_size,radius,measurement"
            ),
        }
        return httpx.Response(
            200,
            json={
                "success": True,
                "duration_ms": 4,
                "result": json.dumps(
                    {
                        "reports": [
                            {
                                "report_key": "near-match",
                                "date": "9/2/2026 12:00 PM",
                                "place_id": "place-1",
                                "keyword": "best breakfast upper west side",
                                "platform": "google",
                            },
                            {
                                "report_key": "exact-new",
                                "date": "9/1/2026 12:00 PM",
                                "place_id": "place-1",
                                "keyword": " breakfast upper west side ",
                                "platform": "google",
                            },
                            {
                                "report_key": "exact-old",
                                "date": "8/28/2026 12:00 PM",
                                "place_id": "place-1",
                                "keyword": "BREAKFAST UPPER WEST SIDE",
                                "platform": "google",
                            },
                        ]
                    }
                ),
            },
        )

    report = make_local_falcon(handler).list_latest_exact_report(
        "place-1", "Breakfast Upper West Side"
    )

    assert report is not None
    assert report["report_key"] == "exact-new"


def test_list_latest_exact_report_rejects_exact_keyword_from_another_place():
    def handler(_request):
        return httpx.Response(
            200,
            json={
                "success": True,
                "duration_ms": 4,
                "result": json.dumps(
                    {
                        "reports": [
                            {
                                "report_key": "wrong-place-newer",
                                "date": "9/2/2026 12:00 PM",
                                "place_id": "place-2",
                                "keyword": "coffee near me",
                                "platform": "google",
                            },
                            {
                                "report_key": "correct-place-older",
                                "date": "9/1/2026 12:00 PM",
                                "place_id": "place-1",
                                "keyword": "ＣＯＦＦＥＥ\u00a0near me",
                                "platform": "google",
                            },
                        ]
                    }
                ),
            },
        )

    report = make_local_falcon(handler).list_latest_exact_report(
        "place-1", "coffee  near me"
    )

    assert report is not None
    assert report["report_key"] == "correct-place-older"


@pytest.mark.parametrize("malformed_reports", [None, {}, "not-a-list"])
def test_list_latest_exact_report_rejects_a_malformed_report_collection(
    malformed_reports,
):
    def handler(_request):
        return httpx.Response(
            200,
            json={
                "success": True,
                "duration_ms": 4,
                "result": json.dumps({"reports": malformed_reports}),
            },
        )

    with pytest.raises(ValueError, match="malformed"):
        make_local_falcon(handler).list_latest_exact_report("place-1", "breakfast")


def test_get_report_requests_only_compact_rank_point_fields():
    def handler(request):
        body = json.loads(request.content)
        assert body["tool_name"] == "getLocalFalconReport"
        args = json.loads(body["arguments"])
        assert args["reportKey"] == "8aa3c7e1f6c599b"
        assert "data_points.*.rank" in args["fieldmask"]
        assert "results" not in args["fieldmask"]
        return httpx.Response(
            200,
            json={
                "success": True,
                "duration_ms": 5,
                "result": json.dumps(
                    {
                        "report_key": "8aa3c7e1f6c599b",
                        "keyword": "breakfast upper west side",
                        "data_points": [
                            {"lat": "40.1", "lng": "-73.2", "found": True, "rank": 1}
                        ],
                    }
                ),
            },
        )

    report = make_local_falcon(handler).get_report("8aa3c7e1f6c599b")

    assert report["data_points"] == [
        {"lat": "40.1", "lng": "-73.2", "found": True, "rank": 1}
    ]


def test_run_scan_submits_one_confirmed_google_grid_without_ai_analysis():
    def handler(request):
        body = json.loads(request.content)
        assert body["tool_name"] == "runLocalFalconScan"
        assert json.loads(body["arguments"]) == {
            "placeId": "place-1",
            "keyword": "breakfast upper west side",
            "lat": 40.7771028,
            "lng": -73.9816854,
            "gridSize": "9",
            "radius": 0.5,
            "measurement": "km",
            "platform": "google",
            "aiAnalysis": False,
        }
        return httpx.Response(
            200,
            json={
                "success": True,
                "duration_ms": 8,
                "result": json.dumps(
                    {
                        "success": True,
                        "message": "Scan submitted successfully",
                        "report_key": "abcdef123456789",
                    }
                ),
            },
        )

    result = make_local_falcon(handler).run_scan(
        place_id="place-1",
        keyword="breakfast upper west side",
        lat=40.7771028,
        lng=-73.9816854,
        grid_size=9,
        radius=0.5,
        measurement="km",
    )

    assert result["report_key"] == "abcdef123456789"


def valid_report_payload():
    return {
        "report_key": "abcdef123456789",
        "date": "9/2/2026 4:00 PM",
        "place_id": "place-1",
        "platform": "google",
        "keyword": "breakfast upper west side",
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
            {
                "lat": str(40.0 + row / 100),
                "lng": str(-73.1 + column / 100),
                "found": True,
                "rank": 2,
            }
            for row in range(3)
            for column in range(3)
        ],
    }


def test_report_normalization_matches_keyword_identity_but_preserves_report_display_text():
    from app.local_falcon import normalize_local_falcon_report

    payload = valid_report_payload()
    payload["keyword"] = "ＢＲＥＡＫＦＡＳＴ\u00a0upper  west side"

    snapshot = normalize_local_falcon_report(
        payload,
        expected_place_id="place-1",
        expected_keyword="breakfast upper west side",
    )

    assert snapshot["keyword"] == "ＢＲＥＡＫＦＡＳＴ\u00a0upper  west side"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("grid_size", 3.9),
        ("grid_size", True),
        ("found_in", 9.5),
        ("found_in", True),
        ("radius", True),
    ],
)
def test_report_normalization_rejects_lossy_or_boolean_numbers(field, value):
    from app.local_falcon import normalize_local_falcon_report

    payload = valid_report_payload()
    payload[field] = value

    with pytest.raises(ValueError):
        normalize_local_falcon_report(
            payload,
            expected_place_id="place-1",
            expected_keyword="breakfast upper west side",
        )


def test_report_normalization_requires_found_and_rank_to_agree():
    from app.local_falcon import normalize_local_falcon_report

    payload = valid_report_payload()
    payload["data_points"][0] = {
        "lat": "40.0",
        "lng": "-73.1",
        "found": False,
        "rank": 5,
    }

    with pytest.raises(ValueError, match="rank"):
        normalize_local_falcon_report(
            payload,
            expected_place_id="place-1",
            expected_keyword="breakfast upper west side",
        )


def test_report_normalization_requires_found_in_to_match_grid_points():
    from app.local_falcon import normalize_local_falcon_report

    payload = valid_report_payload()
    payload["found_in"] = "8"

    with pytest.raises(ValueError, match="found_in"):
        normalize_local_falcon_report(
            payload,
            expected_place_id="place-1",
            expected_keyword="breakfast upper west side",
        )


def test_report_normalization_rejects_duplicate_grid_coordinates():
    from app.local_falcon import normalize_local_falcon_report

    payload = valid_report_payload()
    payload["data_points"][1]["lat"] = payload["data_points"][0]["lat"]
    payload["data_points"][1]["lng"] = payload["data_points"][0]["lng"]

    with pytest.raises(ValueError, match="duplicate coordinate"):
        normalize_local_falcon_report(
            payload,
            expected_place_id="place-1",
            expected_keyword="breakfast upper west side",
        )


def test_report_normalization_rejects_unique_points_that_do_not_form_a_complete_rectangle():
    from app.local_falcon import normalize_local_falcon_report

    payload = valid_report_payload()
    payload["data_points"][-1]["lat"] = "40.99"

    with pytest.raises(ValueError, match="complete rectangular grid"):
        normalize_local_falcon_report(
            payload,
            expected_place_id="place-1",
            expected_keyword="breakfast upper west side",
        )


def test_report_normalization_accepts_the_supported_nine_by_nine_grid():
    from app.local_falcon import normalize_local_falcon_report

    payload = valid_report_payload()
    payload["grid_size"] = "9"
    payload["found_in"] = "81"
    payload["data_points"] = [
        {
            "lat": str(40.0 + row / 100),
            "lng": str(-73.1 + column / 100),
            "found": True,
            "rank": 2,
        }
        for row in range(9)
        for column in range(9)
    ]

    snapshot = normalize_local_falcon_report(
        payload,
        expected_place_id="place-1",
        expected_keyword="breakfast upper west side",
    )

    assert snapshot["grid_size"] == 9
    assert len(snapshot["grid_points"]) == 81


def test_report_normalization_rejects_grids_larger_than_the_supported_nine_by_nine():
    from app.local_falcon import normalize_local_falcon_report

    payload = valid_report_payload()
    payload["grid_size"] = "11"
    payload["found_in"] = "121"
    payload["data_points"] = [
        {
            "lat": str(40.0 + row / 100),
            "lng": str(-73.1 + column / 100),
            "found": True,
            "rank": 2,
        }
        for row in range(11)
        for column in range(11)
    ]

    with pytest.raises(ValueError):
        normalize_local_falcon_report(
            payload,
            expected_place_id="place-1",
            expected_keyword="breakfast upper west side",
        )
