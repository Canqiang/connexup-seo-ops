import json
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .db import get_db


class AuditFindingV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9][a-z0-9_-]{0,99}$")
    area: Literal["GBP", "WEBSITE", "LOCAL_CONTENT", "TECHNICAL", "CITATIONS", "REVIEWS", "ANALYTICS", "OTHER"]
    severity: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]
    observation: str = Field(min_length=1, max_length=2000)
    evidence: list[str] = Field(max_length=10)
    recommendation: str = Field(min_length=1, max_length=2000)


class AuditReportV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["seo_ops.audit_report.v1"]
    merchant_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(min_length=1, max_length=4000)
    evidence_mode: Literal["PUBLIC_AND_CONFIRMED", "CONNECTED_AND_CONFIRMED", "CONFIRMED_FACTS_ONLY"]
    findings: list[AuditFindingV1] = Field(min_length=1, max_length=100)
    limitations: list[str] = Field(max_length=50)
    next_actions: list[str] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def require_limitation_for_unverified_findings(self):
        if any(not finding.evidence for finding in self.findings) and not self.limitations:
            raise ValueError("a finding without evidence requires an explicit limitation")
        return self


def parse_audit_report(raw: object, expected_merchant_id: int) -> AuditReportV1:
    value = raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("audit result must be a JSON object") from exc
    if not isinstance(value, dict):
        raise ValueError("audit result must be a JSON object")
    report = AuditReportV1.model_validate(value)
    if report.merchant_id != str(expected_merchant_id):
        raise ValueError("audit merchant_id does not match the run merchant")
    return report


def persist_audit_snapshot(
    conn: sqlite3.Connection,
    run: sqlite3.Row,
    raw: object,
    accepted_at: str,
) -> sqlite3.Row:
    report = parse_audit_report(raw, expected_merchant_id=run["merchant_id"])
    if conn.execute("SELECT 1 FROM audit_snapshots WHERE run_id = ?", (run["id"],)).fetchone():
        raise ValueError("run already has an accepted audit")
    try:
        cursor = conn.execute(
            "INSERT INTO audit_snapshots"
            " (run_id, merchant_id, schema_version, payload_json, evidence_mode, finding_count, source_ref, accepted_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                run["id"],
                run["merchant_id"],
                report.schema_version,
                report.model_dump_json(),
                report.evidence_mode,
                len(report.findings),
                run["coreai_run_id"],
                accepted_at,
            ),
        )
    except sqlite3.IntegrityError as exc:
        raise ValueError("run already has an accepted audit") from exc
    return conn.execute("SELECT * FROM audit_snapshots WHERE id = ?", (cursor.lastrowid,)).fetchone()


router = APIRouter(prefix="/api", tags=["audits"])


@router.get("/runs/{run_id}/audit")
def get_run_audit(run_id: int, conn=Depends(get_db)):
    if conn.execute("SELECT 1 FROM runs WHERE id = ?", (run_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="run not found")
    row = conn.execute("SELECT * FROM audit_snapshots WHERE run_id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="accepted audit not found")
    result = dict(row)
    result["audit"] = json.loads(result.pop("payload_json"))
    return result
