import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMerchant } from "../src/services/merchantService.js";
import { getTask } from "../src/repos/taskRepo.js";
import { ingestSpecialistRunOutput } from "../src/services/specialistAdapterService.js";
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
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string; proposals: Array<{ id: string }> };
  }

  async function createDirectTask(title: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchantId,
        idempotency_key: `direct-task-${title.replaceAll(" ", "-")}`,
        definition: {
          title,
          task_type: "KEYWORD_WEEKLY",
          source: "MANUAL",
          priority: "MEDIUM",
          impact: "LOW",
          execution_mode: "READ_ONLY",
          execution_spec: JSON.stringify({ cycle: "KEYWORD_WEEKLY" }),
          required_evidence_types: [],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as { id: string };
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
    const adoptedCycle = await fixture.db.one<{ batch_cycle_id: string | null; task_cycle_id: string | null }>(
      `SELECT b.cycle_id AS batch_cycle_id, t.cycle_id AS task_cycle_id
         FROM seo_proposal_batches b
         JOIN seo_tasks t ON t.id = $2
        WHERE b.id = $1`,
      [batch.id, adoption.json().task_id],
    );
    expect(adoptedCycle).toEqual({
      batch_cycle_id: expect.any(String),
      task_cycle_id: expect.any(String),
    });
    expect(adoptedCycle?.task_cycle_id).toBe(adoptedCycle?.batch_cycle_id);

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

  it("returns only the active persisted cycle and never infers legacy membership", async () => {
    const activeBatch = await createPostBatch([proposalItem({ title: "Active cycle proposal" })]);
    const closedBatch = await createPostBatch([proposalItem({ title: "Closed cycle proposal" })]);
    const closedTask = await createDirectTask("Closed cycle task");
    const legacyTask = await createDirectTask("Legacy task without cycle");
    const activeCycle = await fixture.db.one<{ cycle_id: string }>(
      `SELECT cycle_id FROM seo_proposal_batches WHERE id = $1`,
      [activeBatch.id],
    );
    expect(activeCycle?.cycle_id).toBeTruthy();
    await fixture.db.exec(
      `INSERT INTO seo_merchant_cycles (id, merchant_id, starts_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'CLOSED', $3, $3)`,
      ["closed-cycle", merchantId, ISO_EARLY],
    );
    await fixture.db.exec(
      `UPDATE seo_proposal_batches SET cycle_id = 'closed-cycle' WHERE id = $1`,
      [closedBatch.id],
    );
    await fixture.db.exec(
      `UPDATE seo_tasks SET cycle_id = CASE id
        WHEN $1 THEN 'closed-cycle'
        WHEN $2 THEN NULL
        ELSE cycle_id
      END
      WHERE id IN ($1, $2)`,
      [closedTask.id, legacyTask.id],
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchantId}/cycle-ledger`,
    });

    expect(response.statusCode).toBe(200);
    const ids = response.json().items.map((item: { task_id: string | null; proposal_id: string | null }) =>
      item.task_id ?? item.proposal_id,
    );
    expect(ids).toContain(activeBatch.proposals[0]!.id);
    expect(ids).not.toContain(closedBatch.proposals[0]!.id);
    expect(ids).not.toContain(closedTask.id);
    expect(ids).not.toContain(legacyTask.id);
  });

  it("uses a standard adapter-persisted weekly signal and ignores malformed legacy artifacts", async () => {
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
    const weeklyTask = await createDirectTask("Persist weekly associative cluster signal");
    const task = await getTask(fixture.db, weeklyTask.id);
    expect(task).toBeTruthy();
    await ingestSpecialistRunOutput(
      fixture.db,
      task!,
      "weekly-signal-run",
      JSON.stringify({
        schema_version: "seo_ops.keyword_weekly_signal.v1",
        merchant_id: merchantId,
        title: "Weekly cluster signal",
        summary: "Persisted weekly associative reading.",
        observed_at: ISO_EARLY,
        cluster_signals: [{ cluster: "weekday lunch", signal: "IMPROVED", evidence_ref: "ranking:week-34" }],
      }),
    );
    await fixture.db.exec(
      `INSERT INTO seo_specialist_artifacts
        (id, task_id, merchant_id, artifact_type, schema_version, title, summary, payload, core_run_id, created_at)
       VALUES ($1,$2,$3,'KEYWORD_WEEKLY','seo_ops.keyword_weekly_signal.v1',$4,$5,$6,$7,$8)`,
      [
        "invalid-weekly-signal", taskId, merchantId, "Malformed weekly signal", "Legacy payload must not become a UI fact",
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
        artifact_id: expect.any(String),
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
