import { afterEach, describe, expect, it } from "vitest";
import type { AuthActor, SeoPermission } from "../src/auth/types.js";
import { requirePermission } from "../src/auth/httpAuth.js";
import { appendEvidence, createTask } from "../src/services/taskService.js";
import { createMerchant } from "../src/services/merchantService.js";
import { createLocation } from "../src/services/merchantService.js";
import { createQuestionnaire } from "../src/services/questionnaireService.js";
import { insertAgentRun, upsertDeliverable } from "../src/repos/agentRunRepo.js";
import {
  createAuthenticatedTestApp,
  createTestUser,
} from "./helpers/authTest.js";

const taskDefinition = {
  title: "Verify local listing",
  task_type: "LOCAL_LISTING",
  source: "OPERATOR",
  priority: "MEDIUM",
  impact: "MEDIUM",
  execution_spec: '{"action":"verify"}',
  required_evidence_types: [],
};

describe("SEO Ops authorization", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("requires a real session cookie for protected SEO Ops routes", async () => {
    const user = await createAuthenticatedTestApp();
    apps.push(user.app);

    const response = await user.rawInject({ method: "GET", url: "/api/seo-ops/portfolio" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: "AUTH_REQUIRED" });
  });

  it("returns only merchants and tasks assigned to the authenticated operator", async () => {
    const userA = await createAuthenticatedTestApp({ permissions: ["seoops.view", "seoops.manage"] });
    apps.push(userA.app);
    const userB = await createTestUser(userA.db, {
      email: "operator-b@example.test",
      displayName: "Operator B",
    });
    const merchantA = await createMerchant(userA.db, {
      slug: "merchant-a",
      operatorUserIds: [userA.actor.userId],
      idempotencyKey: "merchant-a",
      actorUserId: userA.actor.userId,
    });
    const merchantB = await createMerchant(userA.db, {
      slug: "merchant-b",
      operatorUserIds: [userB.id],
      idempotencyKey: "merchant-b",
      actorUserId: userB.id,
    });
    const taskB = await createTask(userA.db, {
      merchant_id: merchantB.entity.id,
      definition: taskDefinition,
      idempotency_key: "task-b",
    }, userB.id);
    const locationB = await createLocation(userA.db, merchantB.entity.id, {
      slug: "merchant-b-location",
      readinessStatus: "INCOMPLETE",
      missingRequirements: ["GBP"],
      idempotencyKey: "merchant-b-location",
      createdBy: userB.id,
    });
    await appendEvidence(userA.db, taskB.task.id, {
      type: "AUDIT_REPORT",
      source_ref: "https://example.test/hidden-audit",
      captured_at: "2026-08-24T00:00:00.000Z",
      verification_status: "VERIFIED",
      requirement_key: "audit",
      expected_state_version: 1,
      idempotency_key: "hidden-audit",
    }, userB.id);
    const questionnaireB = await createQuestionnaire(userA.db, merchantB.entity.id, {
      idempotencyKey: "questionnaire-b",
    });
    await insertAgentRun(userA.db, {
      id: "run-b",
      merchantId: merchantB.entity.id,
      locationId: null,
      stage: "AUDIT",
      taskId: null,
      runType: "REPORT",
      goal: null,
      status: "COMPLETED",
      coreRunId: null,
      coreStatus: null,
      inputMessage: "scope test",
      output: null,
      error: null,
      errorCode: null,
      tokenUsage: {},
      triggeredBy: userB.id,
      triggeredAt: "2026-08-24T00:00:00.000Z",
      lastPolledAt: null,
      completedAt: "2026-08-24T00:00:00.000Z",
      creationIdempotencyKey: null,
      requestFingerprint: null,
      createdBy: userB.id,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    await upsertDeliverable(userA.db, {
      id: "deliverable-b",
      runId: "run-b",
      kind: "ATTACHMENT",
      fileId: null,
      fileName: "hidden.pdf",
      contentType: "application/pdf",
      size: null,
      title: null,
      description: null,
      sha256: null,
      localPath: null,
      remoteUrl: "https://example.test/hidden-report.pdf",
      downloadedAt: null,
      downloadError: null,
      createdAt: "2026-08-24T00:00:00.000Z",
    });

    const portfolio = await userA.inject({ method: "GET", url: "/api/seo-ops/portfolio" });
    const task = await userA.inject({ method: "GET", url: `/api/seo-ops/tasks/${taskB.task.id}` });

    expect(portfolio.statusCode).toBe(200);
    expect(portfolio.json().merchants).toHaveLength(1);
    expect(portfolio.json().merchants[0].id).toBe(merchantA.entity.id);
    expect(task.statusCode).toBe(404);
    for (const endpoint of ["inbox", "reviews", "reports"]) {
      const response = await userA.inject({
        method: "GET",
        url: `/api/seo-ops/${endpoint}?merchant_id=${merchantB.entity.id}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ items: [], total: 0 });
    }
    await expect(userA.inject({
      method: "POST", url: `/api/seo-ops/merchants/${merchantB.entity.id}/locations`,
      payload: { slug: "hidden", readiness_status: "INCOMPLETE", missing_requirements: ["GBP"], idempotency_key: "hidden-location" },
    })).resolves.toMatchObject({ statusCode: 404 });

    const missingLocation = await userA.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchantA.entity.id,
        location_id: "missing-location",
        definition: taskDefinition,
        idempotency_key: "missing-location-task",
      },
    });
    const hiddenLocation = await userA.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchantA.entity.id,
        location_id: locationB.entity.id,
        definition: taskDefinition,
        idempotency_key: "hidden-location-task",
      },
    });
    expect(hiddenLocation.statusCode).toBe(404);
    expect(hiddenLocation.json()).toEqual(missingLocation.json());

    const missingStageLocation = await userA.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantA.entity.id}/stage-runs`,
      payload: { stage: "AUDIT", location_id: "missing-location", idempotency_key: "missing-stage-location" },
    });
    const hiddenStageLocation = await userA.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantA.entity.id}/stage-runs`,
      payload: { stage: "AUDIT", location_id: locationB.entity.id, idempotency_key: "hidden-stage-location" },
    });
    expect(hiddenStageLocation.statusCode).toBe(404);
    expect(hiddenStageLocation.json()).toEqual(missingStageLocation.json());
    await expect(userA.inject({
      method: "GET", url: `/api/seo-ops/merchants/${merchantB.entity.id}/stage-runs`,
    })).resolves.toMatchObject({ statusCode: 404 });
    await expect(userA.inject({
      method: "GET", url: "/api/seo-ops/agent-runs/run-b",
    })).resolves.toMatchObject({ statusCode: 404 });
    await expect(userA.inject({
      method: "POST", url: "/api/seo-ops/agent-runs/run-b/deliverables",
      payload: { file_name: "hidden.txt", content_base64: "aGlkZGVu" },
    })).resolves.toMatchObject({ statusCode: 404 });
    await expect(userA.inject({
      method: "GET", url: "/api/seo-ops/deliverables/deliverable-b/download",
    })).resolves.toMatchObject({ statusCode: 404 });
    await expect(userA.inject({
      method: "POST", url: `/api/seo-ops/questionnaires/${questionnaireB.entity.id}/send`,
    })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("requires the exact manage permission for a task mutation", async () => {
    const viewer = await createAuthenticatedTestApp({ permissions: ["seoops.view"] });
    apps.push(viewer.app);
    const merchant = await createMerchant(viewer.db, {
      slug: "view-only-merchant",
      operatorUserIds: [viewer.actor.userId],
      idempotencyKey: "view-only-merchant",
      actorUserId: viewer.actor.userId,
    });

    const response = await viewer.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.entity.id,
        definition: taskDefinition,
        idempotency_key: "view-only-task",
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: "FORBIDDEN" });
  });

  it("requires approve rather than manage for an approval preview", async () => {
    const manager = await createAuthenticatedTestApp({ permissions: ["seoops.view", "seoops.manage"] });
    apps.push(manager.app);
    const merchant = await createMerchant(manager.db, {
      slug: "approval-merchant",
      operatorUserIds: [manager.actor.userId],
      idempotencyKey: "approval-merchant",
      actorUserId: manager.actor.userId,
    });
    const task = await createTask(manager.db, {
      merchant_id: merchant.entity.id,
      definition: taskDefinition,
      idempotency_key: "approval-task",
    }, manager.actor.userId);

    const response = await manager.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.task.id}/approval-previews`,
      payload: { task_revision: 1, expected_state_version: 1 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error_code: "FORBIDDEN" });

    const decision = await manager.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.task.id}/approval-decisions`,
      payload: {
        decision: "APPROVE",
        task_revision: 1,
        execution_spec_hash: task.task.executionSpecHash,
        expected_state_version: 1,
        idempotency_key: "manager-cannot-approve",
      },
    });
    expect(decision.statusCode).toBe(403);
    expect(decision.json()).toMatchObject({ error_code: "FORBIDDEN" });
  });

  it("requires manage before stage trigger or cancel", async () => {
    const viewer = await createAuthenticatedTestApp({ permissions: ["seoops.view"] });
    apps.push(viewer.app);
    const merchant = await createMerchant(viewer.db, {
      slug: "stage-view-only",
      operatorUserIds: [viewer.actor.userId],
      idempotencyKey: "stage-view-only",
      actorUserId: viewer.actor.userId,
    });

    const trigger = await viewer.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.entity.id}/stage-runs`,
      payload: { stage: "AUDIT", idempotency_key: "view-only-stage" },
    });
    const cancel = await viewer.inject({
      method: "POST",
      url: "/api/seo-ops/agent-runs/not-a-real-run/cancel",
    });
    expect(trigger.statusCode).toBe(403);
    expect(cancel.statusCode).toBe(403);
  });

  it("matches all six HUMAN permissions exactly", () => {
    const permissions: SeoPermission[] = [
      "seoops.view",
      "seoops.manage",
      "seoops.approve",
      "seoops.execute",
      "seoops.capability.manage",
      "seoops.schedule.manage",
    ];
    for (const granted of permissions) {
      const actor: AuthActor = {
        userId: "permission-test",
        email: "permission-test@example.test",
        name: "Permission test",
        role: "seo_operator",
        identityType: "HUMAN",
        permissions: [granted],
      };
      for (const required of permissions) {
        const request = { actor } as never;
        if (required === granted) {
          expect(requirePermission(request, required)).toBe(actor);
        } else {
          expect(() => requirePermission(request, required)).toThrow(/permission denied/);
        }
      }
    }
  });

  it("self-scopes merchant creation and rejects invalid operator ids", async () => {
    const manager = await createAuthenticatedTestApp({ permissions: ["seoops.manage"] });
    apps.push(manager.app);
    await createTestUser(manager.db, {
      id: "disabled-operator",
      email: "disabled@example.test",
      status: "DISABLED",
    });
    await createTestUser(manager.db, {
      id: "service-operator",
      email: "service@example.test",
      identityType: "SERVICE",
      permissions: ["seoops.view", "seoops.manage"],
    });

    const created = await manager.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: { slug: "self-scoped", operator_user_ids: [manager.actor.userId, manager.actor.userId], idempotency_key: "self-scoped" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().operator_user_ids).toEqual([manager.actor.userId]);

    for (const [slug, operatorId] of [
      ["unknown-operator", "not-a-user"],
      ["disabled-operator", "disabled-operator"],
      ["service-operator", "service-operator"],
    ]) {
      const response = await manager.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: { slug, operator_user_ids: [operatorId], idempotency_key: slug },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error_code: "INVALID_OPERATOR" });
    }
  });

  it("resolves a provisioned SERVICE session but denies approval without its exact permission", async () => {
    const service = await createAuthenticatedTestApp({
      identityType: "SERVICE",
      permissions: ["seoops.view", "seoops.manage"],
    });
    apps.push(service.app);

    const config = await service.inject({ method: "GET", url: "/api/seo-ops/config" });
    const passwordLogin = await service.rawInject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: service.actor.email, password: "Correct horse battery staple 42!" },
    });
    const approval = await service.inject({
      method: "POST",
      url: "/api/seo-ops/tasks/not-a-real-task/approval-previews",
      payload: { task_revision: 1, expected_state_version: 1 },
    });

    expect(config.statusCode).toBe(200);
    expect(passwordLogin.statusCode).toBe(401);
    expect(passwordLogin.json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });
    expect(approval.statusCode).toBe(403);
    expect(approval.json()).toMatchObject({ error_code: "FORBIDDEN" });

    const forbidden: SeoPermission[] = [
      "seoops.approve",
      "seoops.execute",
      "seoops.capability.manage",
      "seoops.schedule.manage",
    ];
    for (const permission of forbidden) {
      await expect(createTestUser(service.db, {
        id: `invalid-service-${permission}`,
        email: `invalid-service-${permission}@example.test`,
        identityType: "SERVICE",
        permissions: ["seoops.view", permission],
      })).rejects.toMatchObject({ status: 400 });
    }
  });
});
