# SEO Ops Production Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Connexup SEO Ops as an operator-ready internal managed-service system, with a stable full test gate, role-separated backend runtime, safe Core AI Agent bindings, UAT deployment manifests, and evidence-backed acceptance of the onboarding and GBP Post workflows.

**Architecture:** PostgreSQL and the SEO Ops server remain the only business-state authority. Core AI UAT supplies bounded specialist Agent Runs through server-side adapters; draft Agents cannot publish, and GBP external writes remain behind approval plus execution confirmation. The production backend runs the same build as three roles (`api`, `worker`, `scheduler`), while the frontend remains a separate static Nginx image.

**Tech Stack:** React 19, TypeScript, Vite 8, Fastify 5, PostgreSQL 16, Zod 3, Vitest 3, Docker, Kubernetes, Core AI HTTP APIs.

**Spec:** `docs/superpowers/specs/2026-08-20-seo-ops-execution-agent-design.md`

## Global Constraints

- Modify product and deployment code only in `/Users/xander/git_repo/connexup-seo-ops`.
- Never modify `/Users/xander/git_repo/core-ai` or `/Users/xander/git_repo/fbr-project`.
- Core AI credentials stay in backend environment/Kubernetes Secrets and never enter browser bundles, logs, Git, plans, or evidence.
- Core AI Run completion never marks an SEO Task complete without schema validation, persistence, and independent SEO Ops readback.
- GBP content generation and external GBP execution use different Agent identities and different capability boundaries.
- A GBP Post is not published until gate 1 approval and gate 2 execution confirmation both bind the exact Task revision, execution-spec hash, draft hash, media hash, location binding, and credential reference.
- `OUTCOME_UNKNOWN` never retries automatically.
- A real George Merchant publication is excluded from unattended acceptance; it requires the user's explicit approval at the moment of gate 2 confirmation.
- Preserve untracked `docs/evidence/` files unless an evidence file is explicitly reviewed and selected for commit.

---

### Task 1: Stabilize and freeze the current GBP Post completion slice

**Files:**
- Modify: `server/vitest.config.ts`
- Modify: `src/features/tasks/DraftsPanel.tsx`
- Test: `src/features/tasks/DraftsPanel.test.tsx`
- Test: `server/tests/gbpPostContentAgent.test.ts`
- Test: `server/tests/gbpExecutionService.test.ts`
- Test: `server/tests/gbpExecutionWorker.test.ts`

**Interfaces:**
- `READY_FOR_APPROVAL -> new editable revision` is exposed as `撤销定稿并继续修改`.
- `APPROVED -> APPROVAL_REVOKED -> new editable revision` is exposed as `撤销批准并继续修改`.
- `test.fileParallelism = false` is the standard PostgreSQL integration-suite policy.

- [ ] **Step 1: Reproduce the complete-suite database saturation**

```bash
cd server
npm test
```

Expected before the configuration fix: unrelated files fail together with PostgreSQL setup/hook timeouts while focused files pass.

- [ ] **Step 2: Run PostgreSQL-backed test files in one Vitest worker**

```ts
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
  },
});
```

- [ ] **Step 3: Verify both final-reopen paths preserve history**

```tsx
fireEvent.click(screen.getByRole("button", { name: "撤销批准并继续修改" }));
await waitFor(() => expect(onReadback).toHaveBeenCalledWith(reopenedTask));
expect(screen.getByRole("status")).toHaveTextContent("原定稿和审批记录已保留");
```

Add the corresponding `READY_FOR_APPROVAL` assertion and verify that it does not call `/approval-decisions`.

- [ ] **Step 4: Run the current-slice gate**

```bash
npm run test:run
npm run build
cd server
npm test
npm run typecheck
npm run build
cd ..
git diff --check
```

Expected: every command exits 0. Record dependency audit as `BLOCKED_BY_REGISTRY` if the configured registry returns `NOT_IMPLEMENTED` for the npm advisory endpoint; do not report it as passed.

- [ ] **Step 5: Commit only the reviewed GBP slice**

```bash
git add server/vitest.config.ts server/src server/tests src/api src/features/tasks src/styles/task.css
git commit -m "feat(gbp): complete reversible post generation and guarded execution"
```

Do not add `docs/evidence/` with a broad path.

---

### Task 2: Separate API, worker, scheduler, and development runtime roles

**Files:**
- Create: `server/src/runtime/role.ts`
- Create: `server/src/runtime/role.test.ts`
- Create: `server/src/runtime/start.ts`
- Modify: `server/src/config.ts`
- Modify: `server/src/index.ts`
- Modify: `server/package.json`

**Interfaces:**
- `RuntimeRole = "api" | "worker" | "scheduler" | "all"`.
- `SEO_OPS_RUNTIME_ROLE` defaults to `all` outside production and is required to be one of `api/worker/scheduler` in production.
- `api` listens on HTTP and starts no poller/worker/scheduler.
- `worker` starts Agent Run polling, execution worker, and GBP worker but no scheduler or HTTP listener.
- `scheduler` starts only cycle scheduling and verification-overdue scanning.

- [ ] **Step 1: Write the failing role matrix test**

```ts
expect(resolveRuntimeRole("api", "production")).toBe("api");
expect(resolveRuntimeRole(undefined, "development")).toBe("all");
expect(() => resolveRuntimeRole("all", "production")).toThrow(/must be api, worker, or scheduler/);
```

- [ ] **Step 2: Implement the role parser**

```ts
export type RuntimeRole = "api" | "worker" | "scheduler" | "all";

export function resolveRuntimeRole(raw: string | undefined, nodeEnv: string | undefined): RuntimeRole {
  const value = raw ?? (nodeEnv === "production" ? "" : "all");
  if (value === "api" || value === "worker" || value === "scheduler") return value;
  if (value === "all" && nodeEnv !== "production") return value;
  throw new Error("SEO_OPS_RUNTIME_ROLE must be api, worker, or scheduler in production");
}
```

- [ ] **Step 3: Extract component startup from `buildApp`**

```ts
export interface RuntimeComponents {
  poller: AgentRunPoller | null;
  executionWorker: ExecutionWorker | null;
  gbpExecutionWorker: GbpExecutionWorker | null;
  scheduler: CycleScheduler | null;
  stop(): Promise<void>;
}
```

`buildApp` constructs the HTTP application only. `startRuntime(role, config)` owns timers and closes them before the database pool.

- [ ] **Step 4: Add explicit scripts**

```json
{
  "start:api": "SEO_OPS_RUNTIME_ROLE=api node --env-file-if-exists=.env dist/runtime/start.js",
  "start:worker": "SEO_OPS_RUNTIME_ROLE=worker node --env-file-if-exists=.env dist/runtime/start.js",
  "start:scheduler": "SEO_OPS_RUNTIME_ROLE=scheduler node --env-file-if-exists=.env dist/runtime/start.js"
}
```

- [ ] **Step 5: Verify role isolation**

```bash
cd server
npm test -- tests/runtimeRole.test.ts tests/agentRunPoller.test.ts tests/executionDomain.test.ts
npm run typecheck
npm run build
```

Commit:

```bash
git add server/src/runtime server/src/config.ts server/src/index.ts server/package.json server/tests
git commit -m "feat(runtime): separate api worker and scheduler roles"
```

---

### Task 3: Add backend image and UAT Kubernetes deployment

**Files:**
- Create: `server/Dockerfile`
- Create: `deploy/uat/namespace.yaml`
- Create: `deploy/uat/configmap.yaml`
- Create: `deploy/uat/api.yaml`
- Create: `deploy/uat/worker.yaml`
- Create: `deploy/uat/scheduler.yaml`
- Create: `deploy/uat/frontend.yaml`
- Create: `deploy/uat/service.yaml`
- Create: `deploy/uat/ingress.yaml`
- Create: `deploy/uat/kustomization.yaml`
- Create: `deploy/uat/README.md`
- Modify: `README.md`
- Modify: `docs/RUNBOOK-v2.md`

**Interfaces:**
- Frontend image serves `/seo-ops/*` on port 8080.
- API image serves `/api/*` and `/health-check` on port 8787.
- Worker and scheduler use the same immutable backend image digest with different runtime roles.
- Secret keys are `DATABASE_URL`, `SESSION_SECRET`, `CORE_AI_TOKEN`, and mounted GBP credential files; no Secret manifest values live in Git.

- [ ] **Step 1: Build the backend as an unprivileged image**

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
USER node
WORKDIR /app/server
COPY --chown=node:node --from=build /app/server/package*.json ./
COPY --chown=node:node --from=build /app/server/node_modules ./node_modules
COPY --chown=node:node --from=build /app/server/dist ./dist
EXPOSE 8787
CMD ["node", "dist/runtime/start.js"]
```

- [ ] **Step 2: Define the API deployment security and probes**

```yaml
securityContext:
  runAsNonRoot: true
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities: { drop: ["ALL"] }
readinessProbe:
  httpGet: { path: /health-check, port: 8787 }
livenessProbe:
  httpGet: { path: /health-check, port: 8787 }
```

Mount an `emptyDir` only at `/app/server/data/artifacts` and mount GBP credentials read-only only on the worker.

- [ ] **Step 3: Define role deployments and same-origin routing**

`api.yaml` sets `SEO_OPS_RUNTIME_ROLE=api`, `worker.yaml` sets `worker`, and `scheduler.yaml` sets `scheduler` with one replica. `ingress.yaml` sends `/api` to the API Service and `/seo-ops` to the frontend Service on the same host.

- [ ] **Step 4: Render and validate manifests without cluster mutation**

```bash
kubectl kustomize deploy/uat > /tmp/seo-ops-uat-rendered.yaml
kubectl apply --dry-run=client -f /tmp/seo-ops-uat-rendered.yaml >/dev/null
```

- [ ] **Step 5: Build both images locally**

```bash
docker build -t connexup-seo-ops-frontend:local .
docker build -f server/Dockerfile -t connexup-seo-ops-server:local .
```

Commit:

```bash
git add server/Dockerfile deploy README.md docs/RUNBOOK-v2.md
git commit -m "feat(deploy): add role-separated UAT manifests"
```

---

### Task 4: Complete pause controls and verification-overdue operations

**Files:**
- Create: `server/src/repos/runtimeControlRepo.ts`
- Create: `server/src/services/runtimeControlService.ts`
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/db/migrate.ts`
- Modify: `server/src/services/executionWorker.ts`
- Modify: `server/src/services/gbpExecutionWorker.ts`
- Modify: `server/src/services/schedulerService.ts`
- Modify: `server/src/routes/executionRoutes.ts`
- Modify: `src/api/types.ts`
- Modify: `src/api/seoOpsApi.ts`
- Modify: `src/features/settings/SystemStatusPanel.tsx`
- Test: `server/tests/runtimeControl.test.ts`
- Test: `src/features/settings/SettingsPage.test.tsx`

**Interfaces:**
- `RuntimeControlScope = "GLOBAL" | "MERCHANT"`.
- Pausing stops new claims/triggers only; it never interrupts an in-flight Run.
- Scheduler promotes elapsed `verify_deadline_at` work into the operator workbench as `VERIFICATION_OVERDUE` without claiming completion or failure.

- [ ] **Step 1: Write the failing pause and overdue tests**

```ts
await setRuntimePause(db, { scope: "MERCHANT", merchantId, paused: true, actorId });
expect(await worker.tick()).toEqual({ claimed: 0, reason: "MERCHANT_PAUSED" });
expect((await listWorkbenchActions(db, actor)).items).toContainEqual(
  expect.objectContaining({ type: "VERIFICATION_OVERDUE", merchantId }),
);
```

- [ ] **Step 2: Add append-audited runtime controls**

```sql
CREATE TABLE seo_runtime_controls (
  id text PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('GLOBAL','MERCHANT')),
  merchant_id text REFERENCES seo_merchants(id),
  paused boolean NOT NULL,
  reason text NOT NULL,
  changed_by text NOT NULL REFERENCES seo_users(id),
  created_at timestamptz NOT NULL
);
```

Read the latest record for global and merchant scope; do not update or delete prior rows.

- [ ] **Step 3: Gate new work in every claimant**

Before selecting or triggering new work, query the effective pause state inside the same transaction/claim cycle. Existing `RUNNING` work continues polling and settling.

- [ ] **Step 4: Add settings controls with exact permission gates**

Only `seoops.schedule.manage` can pause/resume. Render who changed it, when, and the reason. Require a non-empty reason for every change.

- [ ] **Step 5: Verify and commit**

```bash
cd server
npm test -- tests/runtimeControl.test.ts tests/workbench.test.ts tests/executionDomain.test.ts
npm run typecheck
cd ..
npm run test:run -- src/features/settings/SettingsPage.test.tsx
npm run build
git diff --check
git add server/src server/tests/runtimeControl.test.ts src/api src/features/settings
git commit -m "feat(ops): add pause controls and overdue verification"
```

---

### Task 5: Fail closed on unverified content-Agent bindings

**Files:**
- Create: `server/src/services/agentCapabilityPolicy.ts`
- Create: `server/tests/agentCapabilityPolicy.test.ts`
- Modify: `server/src/services/coreAiAgentAdminClient.ts`
- Modify: `server/src/routes/executionRoutes.ts`
- Modify: `server/src/services/gbpPostContentService.ts`
- Modify: `server/core-ai-agents/seo-ops-gbp-post-content-v4.json`
- Modify: `docs/RUNBOOK-v2.md`

**Interfaces:**
- `assertGbpContentAgentPolicy(view)` accepts exactly one built-in media-generation tool, no skills, no subagents, no dataset, no sandbox, no memory, type `AGENT`, status `PUBLISHED`, and response schema `seo_ops.gbp_post_draft.v2`.
- Binding verification stores a sanitized remote editable-config hash in `published_ref`.
- Triggering fails with `CONTENT_AGENT_POLICY_UNVERIFIED` if binding provenance is missing or no longer matches the independently read-back Agent.

- [ ] **Step 1: Write the policy tests**

```ts
expect(() => assertGbpContentAgentPolicy(contentAgentView)).not.toThrow();
expect(() => assertGbpContentAgentPolicy({ ...contentAgentView, tools: [gbpWriteTool] }))
  .toThrow(/external-write tool/);
expect(() => assertGbpContentAgentPolicy({ ...contentAgentView, status: "DRAFT" }))
  .toThrow(/PUBLISHED/);
```

- [ ] **Step 2: Add a read-only agent-detail call to the binding route**

Use the existing server-side Core AI base URL/token. Fetch by exact ID over HTTPS, bound the response size/time, run the policy, and persist only ID, label, published coordinate, and sanitized hash. Never return the token or full prompt.

- [ ] **Step 3: Revalidate before content generation**

`loadGenerationContext` must fail before allocating a Run when the binding has no verified coordinate or when current Agent detail violates the policy. Cache a successful detail for at most 60 seconds by Agent ID and hash; failures are never cached as success.

- [ ] **Step 4: Verify and commit**

```bash
cd server
npm test -- tests/agentCapabilityPolicy.test.ts tests/gbpPostContentAgent.test.ts tests/coreAiAgentAdminClient.test.ts
npm run typecheck
npm run build
git diff --check
git add server/src server/tests server/core-ai-agents docs/RUNBOOK-v2.md
git commit -m "fix(agents): enforce draft-only GBP content capability"
```

---

### Task 6: Perform UAT readback, browser acceptance, and handoff

**Files:**
- Create: `docs/evidence/2026-08-27-seo-ops-production-acceptance.md`
- Modify: `README.md`
- Modify: `docs/RUNBOOK-v2.md`
- Modify only for verified defects: files from Tasks 1–5.

**Interfaces:**
- Acceptance merchants are the three real collaborators plus George Merchant; synthetic pipeline merchants are excluded from the default switcher.
- A safe unattended UAT journey stops after a persisted GBP Post draft and before gate 2.
- A real publication requires an in-the-moment user-approved gate 2 action and independent GBP readback.

- [ ] **Step 1: Run the complete local gate**

```bash
npm run test:run
npm run build
cd server
npm test
npm run typecheck
npm run build
cd ..
git diff --check
```

- [ ] **Step 2: Prove the safe Core AI UAT journey**

Record sanitized identifiers for merchant, location, Task, Core Run, trace, draft, image deliverable, and Task readback. Assert the Task remains `NEEDS_INPUT` or `READY_FOR_APPROVAL`, and independently read back zero new GBP resource names.

- [ ] **Step 3: Verify browser journeys**

At 1440 px, 1024 px, and 390 px verify workbench, merchant cycle ledger, questionnaire, keywords/ranking, audit/report links, GBP generation/edit/upload, finalize, approve, revoke, settings, review, and audit mode. Record defects and screenshots without placing credentials or presigned URLs in Git.

- [ ] **Step 4: Verify deployment artifacts and repository boundaries**

```bash
kubectl kustomize deploy/uat >/tmp/seo-ops-uat-rendered.yaml
git -C /Users/xander/git_repo/core-ai status --short
git -C /Users/xander/git_repo/fbr-project status --short
git status --short --branch
```

Record only whether pre-existing unrelated dirt exists; do not stage or modify it.

- [ ] **Step 5: Gate the optional real George publication**

Stop and request explicit user approval while showing the exact final English copy, image hash/preview, scheduled/immediate mode, Google location identity, Task revision, and execution-spec hash. After approval, confirm gate 2 once, then independently list/get the returned GBP Post resource. Without that approval, record `NOT_EXECUTED_BY_DESIGN`.

- [ ] **Step 6: Commit reviewed acceptance evidence and prepare handoff**

```bash
git add README.md docs/RUNBOOK-v2.md docs/evidence/2026-08-27-seo-ops-production-acceptance.md
git commit -m "docs: record SEO Ops production acceptance"
```

Report exact commits, automated counts, UAT identifiers, evidence gaps, deployment inputs still owned by infrastructure, and the explicit Core AI/FBR source-code boundary statement.

---

## Self-Review

- Spec coverage: stable tests, double-gated GBP drafts/writes, independent runtime roles, UAT deployment, pause/overdue operations, content-Agent capability isolation, and acceptance/readback each have a dedicated task.
- Deferred by explicit product boundary: CMS automatic writes, operation-assistant task dual-write, service-area edits, Post deletion, and unattended George publication.
- Type consistency: runtime roles, pause scopes, workbench action type, binding error code, and Agent output schema names are defined once and reused.
- Placeholder scan: the plan contains no deferred implementation placeholders; every unchecked item has a concrete file, interface, command, or assertion.
