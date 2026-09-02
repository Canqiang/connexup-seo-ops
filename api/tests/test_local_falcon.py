import json

import httpx


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
                                "keyword": "best breakfast upper west side",
                                "platform": "google",
                            },
                            {
                                "report_key": "exact-new",
                                "date": "9/1/2026 12:00 PM",
                                "keyword": " breakfast upper west side ",
                                "platform": "google",
                            },
                            {
                                "report_key": "exact-old",
                                "date": "8/28/2026 12:00 PM",
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
