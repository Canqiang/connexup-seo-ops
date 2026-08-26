import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestUser, createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";
import { createMerchant } from "../src/services/merchantService.js";
import { createProposalBatch } from "../src/services/proposalService.js";
import { settleAttemptUnknown } from "../src/services/executionService.js";
import { insertAttempt, listAttemptsByTask } from "../src/repos/executionRepo.js";

describe("workbench projection", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantA: { id: string };

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;

    merchantA = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: {
          slug: "merchant-a",
          display_name: "Merchant A",
          operator_user_ids: [built.actor.userId],
          idempotency_key: "workbench-merchant-a",
        },
      })
    ).json();
    const location = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchantA.id}/locations`,
        payload: {
          slug: "merchant-a-location",
          display_name: "Merchant A Location",
          readiness_status: "READY",
          idempotency_key: "workbench-location-a",
        },
      })
    ).json();

    await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchantA.id,
        origin: "MANUAL",
        idempotency_key: "workbench-proposal-a",
        items: [{
          title: "Review next keyword set",
          task_type: "KEYWORD_RESEARCH",
          execution_mode: "MANUAL",
          priority: "MEDIUM",
          impact: "MEDIUM",
          execution_spec: "{}",
        }],
      },
    });

    const approvalReady = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/tasks",
        payload: {
          merchant_id: merchantA.id,
          location_id: location.id,
          idempotency_key: "workbench-approval-ready",
          definition: {
            title: "Approve audit findings",
            task_type: "AUDIT",
            source: "OPERATOR",
            priority: "HIGH",
            impact: "MEDIUM",
            execution_mode: "MANUAL",
            execution_spec: "{}",
            required_evidence_types: ["AUDIT_REPORT"],
          },
        },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${approvalReady.id}/evidence`,
      payload: {
        type: "AUDIT_REPORT",
        source_ref: "https://example.test/audit",
        captured_at: "2026-08-25T08:00:00.000Z",
        verification_status: "VERIFIED",
        requirement_key: "AUDIT_REPORT",
        expected_state_version: approvalReady.state_version,
        idempotency_key: "workbench-approval-evidence",
      },
    });

    const unknownTask = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/tasks",
        payload: {
          merchant_id: merchantA.id,
          location_id: location.id,
          idempotency_key: "workbench-unknown-task",
          definition: {
            title: "Confirm business profile update",
            task_type: "GBP_UPDATE",
            source: "OPERATOR",
            priority: "URGENT",
            impact: "HIGH",
            execution_mode: "MANUAL",
            execution_spec: "{}",
            required_evidence_types: [],
          },
        },
      })
    ).json();
    const now = "2026-08-25T09:00:00.000Z";
    await insertAttempt(built.db, {
      id: "workbench-unknown-attempt",
      taskId: unknownTask.id,
      merchantId: merchantA.id,
      attemptNo: 1,
      status: "DISPATCHING",
      gate: "G2",
      agentRunId: null,
      coreRunId: null,
      probeRef: "workbench-probe",
      error: null,
      startedAt: now,
      triggerStartedAt: now,
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
      resolutionNote: null,
      createdAt: now,
      updatedAt: now,
    });
    const [attempt] = await listAttemptsByTask(built.db, unknownTask.id);
    await settleAttemptUnknown(built.db, attempt!, "transport timeout", "system:test");

    const questionnaire = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchantA.id}/questionnaires`,
        payload: { idempotency_key: "workbench-questionnaire" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });

    const operatorB = await createTestUser(built.db, {
      email: "operator-b@example.test",
      displayName: "Operator B",
    });
    const merchantB = await createMerchant(built.db, {
      slug: "merchant-b",
      displayName: "Merchant B",
      operatorUserIds: [operatorB.id],
      idempotencyKey: "workbench-merchant-b",
      actorUserId: operatorB.id,
    });
    await createProposalBatch(built.db, {
      merchant_id: merchantB.entity.id,
      origin: "MANUAL",
      idempotency_key: "workbench-proposal-b",
      items: [{
        title: "Hidden proposal",
        task_type: "KEYWORD_RESEARCH",
        execution_mode: "MANUAL",
        priority: "URGENT",
        impact: "HIGH",
        execution_spec: "{}",
      }],
    }, operatorB.id);
  });

  afterEach(async () => {
    await app.close();
  });

  it("groups only the authenticated operator's human actions", async () => {
    const response = await app.inject({ method: "GET", url: "/api/seo-ops/workbench" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({ gatekeeping: 2, exception: 1, merchant_contact: 1, total: 4 });
    expect(body.items.map((item: { group: string }) => item.group)).toEqual([
      "EXCEPTION", "GATEKEEPING", "GATEKEEPING", "MERCHANT_CONTACT",
    ]);
    expect(body.items.every((item: { merchant_id: string }) => item.merchant_id === merchantA.id)).toBe(true);
  });

  it("paginates before returning rows and rejects an invalid group", async () => {
    const page = await app.inject({ method: "GET", url: "/api/seo-ops/workbench?offset=1&limit=2" });

    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ offset: 1, limit: 2, total: 4 });
    expect(page.json().items).toHaveLength(2);

    const invalid = await app.inject({ method: "GET", url: "/api/seo-ops/workbench?group=RUNNING" });
    expect(invalid.statusCode).toBe(400);
  });
});
