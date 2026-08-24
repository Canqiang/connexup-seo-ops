import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { executionSpecHash } from "../src/domain/hashing.js";
import { getTask } from "../src/repos/taskRepo.js";
import { createTask } from "../src/services/taskService.js";
import { createAuthenticatedTestApp } from "./helpers/authTest.js";

/** Fresh app + fresh schema-isolated postgres db per test. */
async function makeApp(): Promise<FastifyInstance> {
  return (await createAuthenticatedTestApp()).app;
}

const MERCHANT = {
  slug: "acme",
  display_name: "Acme",
  idempotency_key: "mk-1",
};

const LOCATION_READY = {
  slug: "downtown",
  display_name: "Downtown",
  timezone: "America/Los_Angeles",
  external_identities: { google_business: "gid-1" },
  readiness_status: "READY",
  missing_requirements: [],
  idempotency_key: "lk-1",
};

const definition = (overrides: Record<string, unknown> = {}) => ({
  title: "Fix missing meta description",
  task_type: "ON_PAGE_META",
  source: "SEO_AUDIT",
  priority: "HIGH",
  impact: "MEDIUM",
  owner_id: "op-1",
  due_at: "2026-09-01T00:00:00.000Z",
  execution_spec: '{"action":"add_meta","length":150}',
  required_evidence_types: ["APPROVAL_REPORT"],
  ...overrides,
});

/** Full happy-path fixture: ready merchant + location. */
async function seededTask(app: FastifyInstance, overrides: Record<string, unknown> = {}) {
  const merchant = (
    await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: MERCHANT,
    })
  ).json();
  const location = (
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: LOCATION_READY,
    })
  ).json();
  const task = (
    await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.id,
        location_id: location.id,
        definition: definition(overrides),
        idempotency_key: "tk-1",
      },
    })
  ).json();
  return { merchant, location, task };
}

describe("POST /api/seo-ops/tasks", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await makeApp();
  });
  afterEach(() => app.close());

  it("creates a task (201) with derived status NEEDS_INPUT", async () => {
    const { task } = await seededTask(app);
    expect(task.status).toBe("NEEDS_INPUT");
    expect(task.evidence_state).toBe("NONE");
    expect(task.task_revision).toBe(1);
    expect(task.state_version).toBe(1);
    expect(task.execution_spec_hash).toBe(executionSpecHash(definition().execution_spec));
    expect(task.evidence_refs).toEqual([]);
    expect(task.merchant_name).toBe("Acme");
    expect(task.location_name).toBe("Downtown");
  });

  it("records the authenticated operator on every task audit record", async () => {
    const built = await createAuthenticatedTestApp();
    const { app: actorApp, actor, db } = built;
    try {
      const { task: created } = await seededTask(actorApp);
      expect((await getTask(db, created.id))!.createdBy).toBe(actor.userId);

      const revised = await actorApp.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${created.id}/revisions`,
        payload: {
          definition: definition({ title: "Fix revised title" }),
          expected_state_version: 1,
          idempotency_key: "actor-revision",
        },
      });
      expect(revised.statusCode).toBe(201);

      const withEvidence = await actorApp.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${created.id}/evidence`,
        payload: {
          type: "APPROVAL_REPORT",
          source_ref: "gsheets://row/actor",
          captured_at: "2026-08-19T10:00:00.000Z",
          verification_status: "VERIFIED",
          requirement_key: "APPROVAL_REPORT",
          expected_state_version: 2,
          idempotency_key: "actor-evidence",
        },
      });
      expect(withEvidence.statusCode).toBe(201);

      const preview = await actorApp.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${created.id}/approval-previews`,
        payload: { task_revision: 2, expected_state_version: 3 },
      });
      const approved = await actorApp.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${created.id}/approval-decisions`,
        payload: {
          decision: "APPROVE",
          task_revision: 2,
          execution_spec_hash: preview.json().execution_spec_hash,
          expected_state_version: 3,
          idempotency_key: "actor-approval",
        },
      });
      expect(approved.statusCode).toBe(201);

      const stored = (await getTask(db, created.id))!;
      expect(stored.revisions.at(-1)!.createdBy).toBe(actor.userId);
      expect(stored.evidenceRefs.at(-1)!.createdBy).toBe(actor.userId);
      expect(stored.approvalDecisions.at(-1)!.actorId).toBe(actor.userId);
      expect(stored.events.every((event) => event.actorId === actor.userId)).toBe(true);
    } finally {
      await actorApp.close();
    }
  });

  it("keeps the original task actor on an idempotent replay", async () => {
    const { app: actorApp, db, actor } = await createAuthenticatedTestApp();
    try {
      const merchant = (
        await actorApp.inject({
          method: "POST",
          url: "/api/seo-ops/merchants",
          payload: { ...MERCHANT, idempotency_key: "actor-merchant" },
        })
      ).json();
      const input = {
        merchant_id: merchant.id,
        definition: definition(),
        idempotency_key: "actor-task-replay",
      };
      const first = await createTask(db, input, actor.userId);
      const replay = await createTask(db, input, "op-replaying-operator");

      expect(replay.replayed).toBe(true);
      expect(replay.task.id).toBe(first.task.id);
      expect(replay.task.createdBy).toBe(actor.userId);
    } finally {
      await actorApp.close();
    }
  });

  it("404 when merchant is missing or location belongs elsewhere", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: { merchant_id: "nope", definition: definition(), idempotency_key: "x" },
    });
    expect(res.statusCode).toBe(404);

    const other = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: { slug: "beta", idempotency_key: "mk-2" },
      })
    ).json();
    const { location } = await seededTask(app);
    const bad = await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: other.id,
        location_id: location.id,
        definition: definition(),
        idempotency_key: "tk-x",
      },
    });
    expect(bad.statusCode).toBe(404);
  });

  it("replays create idempotently; different body -> 409", async () => {
    const { merchant, location } = await seededTask(app);
    const payload = {
      merchant_id: merchant.id,
      location_id: location.id,
      definition: definition(),
      idempotency_key: "tk-replay",
    };
    const first = await app.inject({ method: "POST", url: "/api/seo-ops/tasks", payload });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({ method: "POST", url: "/api/seo-ops/tasks", payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);

    const clash = await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: { ...payload, definition: definition({ title: "Other" }) },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error_code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects bad priority with 400", async () => {
    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: MERCHANT,
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.id,
        definition: definition({ priority: "ULTRA" }),
        idempotency_key: "tk-bad",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-JSON execution_spec with 400, not 500", async () => {
    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: MERCHANT,
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.id,
        definition: definition({ execution_spec: "not json at all" }),
        idempotency_key: "tk-json",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/execution_spec must be valid JSON/);
  });

  it("rejects unsafe idempotency keys (__proto__) with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: { slug: "proto-test", idempotency_key: "__proto__" },
    });
    expect(res.statusCode).toBe(400);

    const { task } = await seededTask(app);
    const evidence = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: {
        type: "APPROVAL_REPORT",
        source_ref: "s",
        captured_at: "2026-08-19T10:00:00.000Z",
        verification_status: "VERIFIED",
        requirement_key: "APPROVAL_REPORT",
        expected_state_version: task.state_version,
        idempotency_key: "__proto__",
      },
    });
    expect(evidence.statusCode).toBe(400);
    expect(evidence.json().message).toMatch(/idempotency_key/);
  });
});

describe("task sub-mutations (evidence → preview → decision)", () => {
  let app: FastifyInstance;
  let task: Record<string, unknown> & { id: string; state_version: number };

  beforeEach(async () => {
    app = await makeApp();
    task = (await seededTask(app)).task;
  });
  afterEach(() => app.close());

  const evidence = (overrides: Record<string, unknown> = {}) => ({
    type: "APPROVAL_REPORT",
    source_ref: "gsheets://row/42",
    captured_at: "2026-08-19T10:00:00.000Z",
    verification_status: "UNVERIFIED",
    requirement_key: "APPROVAL_REPORT",
    expected_state_version: task.state_version,
    idempotency_key: "ev-1",
    ...overrides,
  });

  it("appends evidence; verified coverage flips to READY_FOR_APPROVAL", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: evidence(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.evidence_state).toBe("PARTIAL");
    expect(body.status).toBe("NEEDS_INPUT");
    expect(body.state_version).toBe(2);

    const verified = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: evidence({
        verification_status: "VERIFIED",
        idempotency_key: "ev-2",
        expected_state_version: 2,
      }),
    });
    expect(verified.statusCode).toBe(201);
    expect(verified.json().status).toBe("READY_FOR_APPROVAL");
    expect(verified.json().evidence_state).toBe("VERIFIED");
  });

  it("evidence validation: exactly one source, sha256 for byte-backed", async () => {
    const both = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: evidence({
        source_ref: "a",
        artifact_id: "b",
        idempotency_key: "ev-x1",
      }),
    });
    expect(both.statusCode).toBe(400);

    const noHash = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: evidence({
        source_ref: undefined,
        artifact_id: "art-1",
        idempotency_key: "ev-x2",
      }),
    });
    expect(noHash.statusCode).toBe(400);
    expect(noHash.json().message).toMatch(/sha256/);
  });

  it("evidence idempotent replay + fingerprint clash + stale version", async () => {
    const url = `/api/seo-ops/tasks/${task.id}/evidence`;
    const first = await app.inject({ method: "POST", url, payload: evidence() });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({ method: "POST", url, payload: evidence() });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);

    const clash = await app.inject({
      method: "POST",
      url,
      payload: evidence({ captured_at: "2026-08-19T11:00:00.000Z" }),
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error_code).toBe("IDEMPOTENCY_CONFLICT");

    const stale = await app.inject({
      method: "POST",
      url,
      payload: evidence({ idempotency_key: "ev-3", expected_state_version: 99 }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error_code).toBe("STALE_STATE");
  });

  it("preview: blocked until verified, then reviewable", async () => {
    const before = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-previews`,
      payload: { task_revision: 1, expected_state_version: 1 },
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ reviewable: false });
    expect(before.json().blockers.length).toBeGreaterThan(0);

    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: evidence({ verification_status: "VERIFIED" }),
    });
    const after = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-previews`,
      payload: { task_revision: 1, expected_state_version: 2 },
    });
    expect(after.json()).toMatchObject({ reviewable: true, blockers: [] });
  });

  it("preview with stale revision/version -> 409 STALE_STATE", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-previews`,
      payload: { task_revision: 2, expected_state_version: 1 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe("STALE_STATE");
  });

  const readyForApproval = async () => {
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: evidence({ verification_status: "VERIFIED" }),
    });
    return (await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-previews`,
      payload: { task_revision: 1, expected_state_version: 2 },
    })).json();
  };

  it("approve: READY_FOR_APPROVAL -> APPROVED, then revise is rejected until revoke", async () => {
    const preview = await readyForApproval();
    const approve = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "APPROVE",
        task_revision: preview.task_revision,
        execution_spec_hash: preview.execution_spec_hash,
        expected_state_version: preview.state_version,
        idempotency_key: "dec-1",
      },
    });
    expect(approve.statusCode).toBe(201);
    expect(approve.json().status).toBe("APPROVED");
    expect(approve.json().state_version).toBe(3);
    expect(approve.json().approval_decisions).toHaveLength(1);
    expect(approve.json().approval_decisions[0]).toMatchObject({
      decision: "APPROVE",
      resulting_state_version: 3,
    });

    const reviseWhileApproved = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/revisions`,
      payload: {
        definition: definition({ title: "v2" }),
        expected_state_version: 3,
        idempotency_key: "rev-1",
      },
    });
    expect(reviseWhileApproved.statusCode).toBe(409);
    expect(reviseWhileApproved.json().error_code).toBe("INVALID_TRANSITION");

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "APPROVE",
        task_revision: preview.task_revision,
        execution_spec_hash: preview.execution_spec_hash,
        expected_state_version: preview.state_version,
        idempotency_key: "dec-1",
      },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(approve.json().id);

    const revoke = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "REVOKE",
        reason: "spec changed in prod",
        task_revision: 1,
        execution_spec_hash: preview.execution_spec_hash,
        expected_state_version: 3,
        idempotency_key: "dec-2",
      },
    });
    expect(revoke.statusCode).toBe(201);
    expect(revoke.json().status).toBe("APPROVAL_REVOKED");
  });

  it("reject needs input (NOT ready) -> 409 INVALID_TRANSITION; REJECT requires reason", async () => {
    const rejectNotReady = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "REJECT",
        reason: "no",
        task_revision: 1,
        execution_spec_hash: task.execution_spec_hash,
        expected_state_version: 1,
        idempotency_key: "dec-n1",
      },
    });
    expect(rejectNotReady.statusCode).toBe(409);
    expect(rejectNotReady.json().error_code).toBe("INVALID_TRANSITION");

    const preview = await readyForApproval();
    const noReason = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "REJECT",
        task_revision: preview.task_revision,
        execution_spec_hash: preview.execution_spec_hash,
        expected_state_version: preview.state_version,
        idempotency_key: "dec-n2",
      },
    });
    expect(noReason.statusCode).toBe(400);

    const withReason = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "REJECT",
        reason: "evidence is thin",
        task_revision: preview.task_revision,
        execution_spec_hash: preview.execution_spec_hash,
        expected_state_version: preview.state_version,
        idempotency_key: "dec-n3",
      },
    });
    expect(withReason.statusCode).toBe(201);
    expect(withReason.json().status).toBe("REVISION_REQUIRED");
  });

  it("revision: bumps task_revision, resets evidence, allows new spec hash", async () => {
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: evidence({ verification_status: "VERIFIED" }),
    });
    const revised = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/revisions`,
      payload: {
        definition: definition({ execution_spec: '{"action":"add_meta","length":160}' }),
        expected_state_version: 2,
        idempotency_key: "rev-1",
      },
    });
    expect(revised.statusCode).toBe(201);
    const body = revised.json();
    expect(body.task_revision).toBe(2);
    expect(body.state_version).toBe(3);
    expect(body.evidence_state).toBe("NONE");
    expect(body.status).toBe("NEEDS_INPUT");
    expect(body.execution_spec_hash).toBe(executionSpecHash('{"action":"add_meta","length":160}'));

    // decision carrying the OLD revision/hash now fails as stale
    const staleDecision = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "APPROVE",
        task_revision: 1,
        execution_spec_hash: task.execution_spec_hash,
        expected_state_version: 3,
        idempotency_key: "dec-s1",
      },
    });
    expect(staleDecision.statusCode).toBe(409);
    expect(staleDecision.json().error_code).toBe("STALE_STATE");
  });

  it("link conversation appends link + event", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/conversation-links`,
      payload: {
        conversation_id: "conv-7",
        expected_state_version: 1,
        idempotency_key: "cl-1",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.conversation_links).toEqual([
      expect.objectContaining({ conversation_id: "conv-7", relationship: "TASK_CHAT" }),
    ]);
    expect(body.state_version).toBe(2);
  });

  it("404 for unknown task on every sub-mutation", async () => {
    for (const path of ["revisions", "evidence", "conversation-links", "approval-previews", "approval-decisions"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/nope/${path}`,
        payload: { task_revision: 1, expected_state_version: 1, idempotency_key: "z" },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("blocked location blocks approval", () => {
  it("task linked to a BLOCKED location stays BLOCKED even with verified evidence", async () => {
    const app = await makeApp();
    try {
      const merchant = (
        await app.inject({
          method: "POST",
          url: "/api/seo-ops/merchants",
          payload: MERCHANT,
        })
      ).json();
      const blocked = (
        await app.inject({
          method: "POST",
          url: `/api/seo-ops/merchants/${merchant.id}/locations`,
          payload: {
            slug: "stuck",
            readiness_status: "BLOCKED",
            missing_requirements: ["GOOGLE_ACCESS"],
            external_identities: {},
            idempotency_key: "lk-2",
          },
        })
      ).json();
      const task = (
        await app.inject({
          method: "POST",
          url: "/api/seo-ops/tasks",
          payload: {
            merchant_id: merchant.id,
            location_id: blocked.id,
            definition: definition(),
            idempotency_key: "tk-b1",
          },
        })
      ).json();
      expect(task.status).toBe("BLOCKED");

      const withEvidence = await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/evidence`,
        payload: {
          type: "APPROVAL_REPORT",
          source_ref: "s",
          captured_at: "2026-08-19T10:00:00.000Z",
          verification_status: "VERIFIED",
          requirement_key: "APPROVAL_REPORT",
          expected_state_version: 1,
          idempotency_key: "ev-b1",
        },
      });
      expect(withEvidence.json().status).toBe("BLOCKED");
      expect(withEvidence.json().evidence_state).toBe("VERIFIED");

      const preview = await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/approval-previews`,
        payload: { task_revision: 1, expected_state_version: 2 },
      });
      expect(preview.json().reviewable).toBe(false);
      expect(preview.json().blockers.join(" ")).toMatch(/location_not_ready/);
    } finally {
      await app.close();
    }
  });
});
