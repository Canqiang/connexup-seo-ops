import json

import pytest
from pydantic import ValidationError

from app.audit_snapshots import parse_audit_report, persist_audit_snapshot
from app.db import connect


def audit_payload(merchant_id: str = "1") -> dict:
    return {
        "schema_version": "seo_ops.audit_report.v1",
        "merchant_id": merchant_id,
        "title": "Local SEO initial audit",
        "summary": "The merchant identity is confirmed, but location evidence is incomplete.",
        "evidence_mode": "CONFIRMED_FACTS_ONLY",
        "findings": [
            {
                "id": "location-gap",
                "area": "GBP",
                "severity": "HIGH",
                "observation": "A complete public address was not supplied.",
                "evidence": ["Merchant questionnaire has no street address."],
                "recommendation": "Confirm the canonical NAP before changing GBP.",
            }
        ],
        "limitations": ["No connected GBP access was used."],
        "next_actions": ["Confirm the canonical business address."],
    }


def create_run(client):
    merchant = client.post("/api/merchants", json={"name": "Audit Merchant"}).json()
    conn = connect()
    try:
        cursor = conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'core-audit-1', 'succeeded', 'manual', '2026-09-01T10:00:00+00:00',"
            " '2026-09-01T10:01:00+00:00')",
            (merchant["id"],),
        )
        conn.commit()
        return merchant, cursor.lastrowid
    finally:
        conn.close()


def test_parse_audit_report_accepts_only_the_strict_contract():
    parsed = parse_audit_report(json.dumps(audit_payload()), expected_merchant_id=1)

    assert parsed.schema_version == "seo_ops.audit_report.v1"
    assert parsed.findings[0].severity == "HIGH"

    with pytest.raises(ValueError, match="JSON object"):
        parse_audit_report("# Markdown report", expected_merchant_id=1)

    extra = audit_payload()
    extra["score"] = 83
    with pytest.raises(ValidationError):
        parse_audit_report(json.dumps(extra), expected_merchant_id=1)

    no_evidence = audit_payload()
    no_evidence["findings"][0]["evidence"] = []
    with pytest.raises(ValidationError):
        parse_audit_report(json.dumps(no_evidence), expected_merchant_id=1)

    with pytest.raises(ValueError, match="merchant_id"):
        parse_audit_report(json.dumps(audit_payload("other")), expected_merchant_id=1)


def test_persisted_snapshot_is_normalized_and_available_by_run(client):
    merchant, run_id = create_run(client)
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        snapshot = persist_audit_snapshot(
            conn,
            row,
            json.dumps(audit_payload(str(merchant["id"])), indent=2),
            "2026-09-01T10:02:00+00:00",
        )
        assert snapshot["finding_count"] == 1
        assert json.loads(snapshot["payload_json"]) == audit_payload(str(merchant["id"]))
        conn.commit()
    finally:
        conn.close()

    response = client.get(f"/api/runs/{run_id}/audit")

    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == run_id
    assert body["merchant_id"] == merchant["id"]
    assert body["source_ref"] == "core-audit-1"
    assert body["audit"] == audit_payload(str(merchant["id"]))


def test_snapshot_endpoint_is_404_until_an_audit_is_accepted(client):
    _merchant, run_id = create_run(client)

    response = client.get(f"/api/runs/{run_id}/audit")

    assert response.status_code == 404
    assert response.json()["detail"] == "accepted audit not found"


def test_one_run_cannot_silently_replace_an_accepted_snapshot(client):
    merchant, run_id = create_run(client)
    conn = connect()
    try:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        persist_audit_snapshot(
            conn,
            run,
            json.dumps(audit_payload(str(merchant["id"]))),
            "2026-09-01T10:02:00+00:00",
        )
        changed = audit_payload(str(merchant["id"]))
        changed["summary"] = "A different result"

        with pytest.raises(ValueError, match="already has an accepted audit"):
            persist_audit_snapshot(
                conn,
                run,
                json.dumps(changed),
                "2026-09-01T10:03:00+00:00",
            )
    finally:
        conn.close()


def test_snapshot_persistence_participates_in_the_callers_transaction(client):
    merchant, run_id = create_run(client)
    conn = connect()
    try:
        run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        persist_audit_snapshot(
            conn,
            run,
            json.dumps(audit_payload(str(merchant["id"]))),
            "2026-09-01T10:02:00+00:00",
        )
        conn.rollback()
    finally:
        conn.close()

    assert client.get(f"/api/runs/{run_id}/audit").status_code == 404
