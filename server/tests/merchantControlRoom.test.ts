import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMerchant } from "../src/services/merchantService.js";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

const ISO_EARLY = "2026-08-21T09:00:00.000Z";
const ISO_LATE = "2026-08-28T09:00:00.000Z";

function proposalItem(overrides: Record<string, unknown> = {}) {
  return {
    title: "Draft this week's GBP Post",
    task_type: "GBP_POST",
    execution_mode: "MANUAL",
    due_at: ISO_LATE,
    priority: "MEDIUM",
    impact: "LOW",
    execution_spec: JSON.stringify({ cycle: "WEEKLY_POST" }),
    ...overrides,
  };
}

describe("merchant control room projections", () => {
  let fixture: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;

  beforeEach(async () => {
    fixture = await createAuthenticatedTestApp();
    app = fixture.app;
    const created = await createMerchant(fixture.db, {
      slug: "merchant-control-room",
      displayName: "Merchant Control Room",
      operatorUserIds: [fixture.actor.userId],
      idempotencyKey: "merchant-control-room",
      actorUserId: fixture.actor.userId,
    });
    merchantId = created.entity.id;
  });

  afterEach(async () => app.close());

  async function createPostBatch(items: Array<Record<string, unknown>>) {
    const response = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchantId,
        origin: "MANUAL",
        idempotency_key: `post-batch-${items.length}-${Math.random()}`,
        items,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { proposals: Array<{ id: string }> };
  }

  it("keeps accepted tasks and pending proposals distinct in one dated ledger", async () => {
    const batch = await createPostBatch([
      proposalItem({ title: "Publish late-week GBP Post" }),
      proposalItem({
        title: "Draft early-week GBP Post",
        due_at: ISO_EARLY,
        depends_on: [1],
      }),
    ]);
    const adoptedProposal = batch.proposals[0]!;
    const pendingProposal = batch.proposals[1]!;
    const adoption = await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${adoptedProposal.id}/decision`,
      payload: { action: "ADOPT" },
    });
    expect(adoption.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchantId}/cycle-ledger`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_kind: "TASK",
        task_id: adoption.json().task_id,
        proposal_id: adoptedProposal.id,
        validation_failures: [],
      }),
      expect.objectContaining({
        record_kind: "PROPOSAL",
        task_id: null,
        proposal_id: pendingProposal.id,
        dependency_labels: ["Publish late-week GBP Post"],
      }),
    ]));
    expect(body.items.map((item) => item.record_kind)).toEqual(["PROPOSAL", "TASK"]);
    expect(body.items.find((item) => item.proposal_id === adoptedProposal.id)?.record_kind).toBe("TASK");
  });

  it("does not manufacture a voice profile or performance signal", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchantId}/post-program`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      voice_profile: null,
      cluster_signals: [],
      history: [],
      proposals: [],
    });
    expect(response.json().evidence_gaps).toEqual(expect.arrayContaining([
      "VOICE_PROFILE_MISSING",
      "CLUSTER_SIGNAL_MISSING",
      "POST_HISTORY_MISSING",
      "POST_PROPOSAL_MISSING",
    ]));
  });

  it("uses validated persisted evidence for the Post program and ignores malformed legacy artifacts", async () => {
    const batch = await createPostBatch([proposalItem({ title: "Publish verified GBP Post" })]);
    const adopted = await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${batch.proposals[0]!.id}/decision`,
      payload: { action: "ADOPT" },
    });
    const taskId = adopted.json().task_id as string;
    await fixture.db.exec(
      `UPDATE seo_tasks
       SET status = 'DONE', published_ref = $1, published_at = $2, verified_at = $3, verified_by = $4
       WHERE id = $5`,
      ["gbp-post-123", ISO_EARLY, ISO_LATE, fixture.actor.userId, taskId],
    );
    const voice = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/style-profile`,
      payload: { voice: { tone: "friendly", banned: ["guaranteed"] } },
    });
    expect(voice.statusCode).toBe(201);
    await fixture.db.exec(
      `INSERT INTO seo_specialist_artifacts
        (id, task_id, merchant_id, artifact_type, schema_version, title, summary, payload, core_run_id, created_at)
       VALUES
        ($1,$2,$3,'KEYWORD_WEEKLY','seo_ops.keyword_weekly.v1',$4,$5,$6,$7,$8),
        ($9,$2,$3,'KEYWORD_WEEKLY','seo_ops.keyword_weekly.v1',$10,$11,$12,$13,$14)`,
      [
        "valid-weekly-signal", taskId, merchantId, "Weekly cluster signal", "Persisted weekly reading",
        JSON.stringify({
          schema_version: "seo_ops.keyword_weekly.v1",
          merchant_id: merchantId,
          observed_at: ISO_EARLY,
          cluster_signals: [{ cluster: "weekday lunch", signal: "IMPROVED", evidence_ref: "ranking:week-34" }],
        }),
        "weekly-signal-run", ISO_EARLY,
        "invalid-weekly-signal", "Malformed weekly signal", "Legacy payload must not become a UI fact",
        JSON.stringify({ cluster_signals: [{ cluster: "invented", signal: "UP" }] }),
        "legacy-weekly-signal-run", ISO_LATE,
      ],
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchantId}/post-program`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      voice_profile: {
        version: 1,
        voice: { tone: "friendly", banned: ["guaranteed"] },
      },
      cluster_signals: [{
        artifact_id: "valid-weekly-signal",
        cluster: "weekday lunch",
        signal: "IMPROVED",
        observed_at: ISO_EARLY,
      }],
      history: [{
        task_id: taskId,
        published_ref: "gbp-post-123",
        published_at: ISO_EARLY,
        verified_at: ISO_LATE,
      }],
    });
    expect(response.json().evidence_gaps).toContain("INVALID_KEYWORD_WEEKLY_ARTIFACT");
    expect(response.json().cluster_signals).toHaveLength(1);
  });
});
