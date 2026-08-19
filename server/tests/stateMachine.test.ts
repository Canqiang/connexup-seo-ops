import { describe, expect, it } from "vitest";
import {
  canAppendEvidence,
  canCreateRevision,
  decideApproval,
  evaluate,
  evaluateEvidenceState,
  type EvidenceLike,
} from "../src/domain/stateMachine.js";

const ev = (
  taskRevision: number,
  verificationStatus: string,
  requirementKey: string,
): EvidenceLike => ({ taskRevision, verificationStatus, requirementKey });

describe("transitions", () => {
  it("allows revision from every non-approved workflow state", () => {
    for (const status of [
      "DRAFT",
      "NEEDS_INPUT",
      "BLOCKED",
      "READY_FOR_APPROVAL",
      "REVISION_REQUIRED",
      "APPROVAL_REVOKED",
    ]) {
      expect(canCreateRevision(status)).toBe(true);
    }
    expect(canCreateRevision("APPROVED")).toBe(false);
  });

  it("allows evidence only pre-approval", () => {
    for (const status of [
      "DRAFT",
      "NEEDS_INPUT",
      "BLOCKED",
      "READY_FOR_APPROVAL",
    ]) {
      expect(canAppendEvidence(status)).toBe(true);
    }
    for (const status of ["APPROVED", "REVISION_REQUIRED", "APPROVAL_REVOKED"]) {
      expect(canAppendEvidence(status)).toBe(false);
    }
  });

  it("resolves approval transitions per the locked table", () => {
    expect(decideApproval("READY_FOR_APPROVAL", "APPROVE")).toBe("APPROVED");
    expect(decideApproval("READY_FOR_APPROVAL", "REJECT")).toBe(
      "REVISION_REQUIRED",
    );
    expect(decideApproval("APPROVED", "REVOKE")).toBe("APPROVAL_REVOKED");
    expect(decideApproval("DRAFT", "APPROVE")).toBeNull();
    expect(decideApproval("APPROVED", "APPROVE")).toBeNull();
    expect(decideApproval("READY_FOR_APPROVAL", "REVOKE")).toBeNull();
  });
});

describe("evidence state derivation", () => {
  it("no evidence -> NONE", () => {
    expect(evaluateEvidenceState(["APPROVAL_REPORT"], [], 1)).toBe("NONE");
  });

  it("some verified → PARTIAL", () => {
    const evidence = [ev(1, "VERIFIED", "REQUIREMENT_A")];
    expect(
      evaluateEvidenceState(["REQUIREMENT_A", "REQUIREMENT_B"], evidence, 1),
    ).toBe("PARTIAL");
  });

  it("all required verified for current revision -> VERIFIED", () => {
    const evidence = [
      ev(1, "VERIFIED", "REQUIREMENT_A"),
      ev(1, "VERIFIED", "REQUIREMENT_B"),
    ];
    expect(
      evaluateEvidenceState(["REQUIREMENT_A", "REQUIREMENT_B"], evidence, 1),
    ).toBe("VERIFIED");
  });

  it("ignores evidence from other revisions", () => {
    const evidence = [ev(1, "VERIFIED", "REQUIREMENT_A")];
    // evaluating revision 2
    expect(
      evaluateEvidenceState(["REQUIREMENT_A"], evidence, 2),
    ).toBe("NONE");
  });

  it("UNVERIFIABLE when a required type has no verified/pending replacement", () => {
    const evidence = [ev(1, "UNVERIFIABLE", "REQ")];
    expect(evaluateEvidenceState(["REQ"], evidence, 1)).toBe("UNVERIFIABLE");
  });

  it("pending UNVERIFIED entry keeps state out of UNVERIFIABLE", () => {
    const evidence = [
      ev(1, "UNVERIFIABLE", "REQ"),
      ev(1, "UNVERIFIED", "REQ"),
    ];
    expect(evaluateEvidenceState(["REQ"], evidence, 1)).toBe("PARTIAL");
  });
});

describe("readiness (status derivation)", () => {
  it("blocked location -> BLOCKED regardless of evidence", () => {
    const result = evaluate(
      ["REQ"],
      [ev(1, "VERIFIED", "REQ")],
      1,
      "BLOCKED",
    );
    expect(result.status).toBe("BLOCKED");
  });

  it("verified evidence + ready location -> READY_FOR_APPROVAL", () => {
    const result = evaluate(["REQ"], [ev(1, "VERIFIED", "REQ")], 1, "READY");
    expect(result.status).toBe("READY_FOR_APPROVAL");
    expect(result.evidenceState).toBe("VERIFIED");
  });

  it("no evidence -> NEEDS_INPUT", () => {
    const result = evaluate(["REQ"], [], 1, "READY");
    expect(result.status).toBe("NEEDS_INPUT");
    expect(result.evidenceState).toBe("NONE");
  });

  it("unverifiable evidence -> BLOCKED", () => {
    const result = evaluate(
      ["REQ"],
      [ev(1, "UNVERIFIABLE", "REQ")],
      1,
      "READY",
    );
    expect(result.status).toBe("BLOCKED");
    expect(result.evidenceState).toBe("UNVERIFIABLE");
  });

  it("no location link -> evidence alone decides", () => {
    const result = evaluate(["REQ"], [ev(1, "VERIFIED", "REQ")], 1, null);
    expect(result.status).toBe("READY_FOR_APPROVAL");
  });
});
