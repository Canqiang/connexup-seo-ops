import { afterEach, describe, expect, it } from "vitest";
import { insertSpecialistArtifact } from "../src/repos/specialistArtifactRepo.js";
import { createAuthenticatedTestApp } from "./helpers/authTest.js";

describe("specialist artifact acceptance", () => {
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
  });

  it("requires authentication and the exact seoops.approve permission", async () => {
    const built = await createAuthenticatedTestApp();
    const manager = await createAuthenticatedTestApp({
      permissions: ["seoops.view", "seoops.manage"],
    });
    apps.push(built.app, manager.app);

    const unauthenticated = await built.rawInject({
      method: "POST",
      url: "/api/seo-ops/artifacts/missing/acceptance",
      payload: { decision: "ACCEPTED" },
    });
    const wrongPermission = await manager.inject({
      method: "POST",
      url: "/api/seo-ops/artifacts/missing/acceptance",
      payload: { decision: "ACCEPTED" },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(wrongPermission.statusCode).toBe(403);
  });

  it("persists tenant-scoped decisions, replays the same decision, and rejects conflicts", async () => {
    const built = await createAuthenticatedTestApp();
    apps.push(built.app);
    const { app, db, actor } = built;
    const merchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "artifact-acceptance-store",
        display_name: "Artifact Acceptance Store",
        idempotency_key: "artifact-acceptance-store",
      },
    })).json();
    const foreignMerchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "artifact-foreign-store",
        display_name: "Foreign Store",
        idempotency_key: "artifact-foreign-store",
      },
    })).json();
    const now = "2026-08-27T00:00:00.000Z";
    for (const [id, merchantId] of [
      ["artifact-to-accept", merchant.id],
      ["artifact-foreign", foreignMerchant.id],
    ] as const) {
      await insertSpecialistArtifact(db, {
        id,
        taskId: `task-${id}`,
        merchantId,
        artifactType: "AUDIT_REPORT",
        schemaVersion: "seo_ops.audit_report.v1",
        title: "Audit",
        summary: "Evidence bounded audit",
        payload: { finding_count: 1 },
        coreRunId: `run-${id}`,
        createdBy: actor.userId,
        createdAt: now,
      });
    }

    const pending = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchant.id}/artifacts`,
    });
    expect(pending.statusCode).toBe(200);
    expect(pending.json().items[0]).toMatchObject({
      id: "artifact-to-accept",
      acceptance_status: "PENDING",
      acceptance_decided_by: null,
      acceptance_decided_at: null,
      acceptance_note: null,
    });

    await db.exec(
      `UPDATE seo_merchants SET operator_user_ids = $2 WHERE id = $1`,
      [foreignMerchant.id, JSON.stringify(["another-operator"])],
    );
    const foreign = await app.inject({
      method: "POST",
      url: "/api/seo-ops/artifacts/artifact-foreign/acceptance",
      payload: { decision: "ACCEPTED" },
    });
    expect(foreign.statusCode).toBe(404);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/seo-ops/artifacts/artifact-to-accept/acceptance",
      payload: { decision: "ACCEPTED", note: "Approved for the frozen merchant report." },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      id: "artifact-to-accept",
      acceptance_status: "ACCEPTED",
      acceptance_decided_by: actor.userId,
      acceptance_note: "Approved for the frozen merchant report.",
    });
    expect(accepted.json().acceptance_decided_at).toEqual(expect.any(String));

    const replay = await app.inject({
      method: "POST",
      url: "/api/seo-ops/artifacts/artifact-to-accept/acceptance",
      payload: { decision: "ACCEPTED", note: "A later replay must not rewrite audit state." },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(accepted.json());

    const conflict = await app.inject({
      method: "POST",
      url: "/api/seo-ops/artifacts/artifact-to-accept/acceptance",
      payload: { decision: "REJECTED", note: "Conflicting decision" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error_code).toBe("ARTIFACT_ACCEPTANCE_CONFLICT");

    const readback = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchant.id}/artifacts`,
    });
    expect(readback.json().items[0]).toEqual(accepted.json());
  });

  it("ordinary artifact insertion cannot forge a human acceptance decision", async () => {
    const built = await createAuthenticatedTestApp();
    apps.push(built.app);
    const merchant = (await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "artifact-forgery-store",
        display_name: "Artifact Forgery Store",
        idempotency_key: "artifact-forgery-store",
      },
    })).json();

    const forgedRepositoryInput = {
      id: "artifact-forged-acceptance",
      taskId: "task-artifact-forged-acceptance",
      merchantId: merchant.id,
      artifactType: "AUDIT_REPORT",
      schemaVersion: "seo_ops.audit_report.v1",
      title: "Audit",
      summary: "Generated output is not a human decision.",
      payload: { finding_count: 1 },
      coreRunId: "run-artifact-forged-acceptance",
      createdBy: built.actor.userId,
      createdAt: "2026-08-27T00:00:00.000Z",
      acceptanceStatus: "ACCEPTED",
      acceptanceDecidedBy: "forged-actor",
      acceptanceDecidedAt: "2026-08-27T00:00:00.000Z",
      acceptanceNote: "forged acceptance",
    } as unknown as Parameters<typeof insertSpecialistArtifact>[1];
    const inserted = await insertSpecialistArtifact(built.db, forgedRepositoryInput);

    expect(inserted).toMatchObject({
      acceptanceStatus: "PENDING",
      acceptanceDecidedBy: null,
      acceptanceDecidedAt: null,
      acceptanceNote: null,
    });
  });
});
