# SEO Ops production-completion acceptance — 2026-08-27

## Scope

- Repository under test: `connexup-seo-ops` feature worktree only.
- Core AI and FBR Project are treated as external systems; no source changes are part of this delivery.
- Local application: `http://127.0.0.1:5173/seo-ops/` with the API on `http://127.0.0.1:8787`.

## Verified acceptance evidence

- Frontend: 30 test files, 196 tests passed; TypeScript and Vite production build passed.
- Backend: 39 test files, 450 tests passed; TypeScript typecheck and build passed.
- Formatting: `git diff --check` passed.
- Runtime: `/health-check` returned HTTP 200 and `{ "status": "ok" }`.
- Portfolio readback returned exactly four operator-visible merchant records:
  - Choice Brooklyn · Upper West Side
  - George · ghc1
  - Keke Food · Flushing NY
  - Only Bear Chicken & Boba
- Repeated manual scheduler ticks returned an empty `created` set and zero dispatches, with no idempotency conflict.
- Browser acceptance at 1024 px and 390 px found no horizontal overflow on the workbench; task, reviews, reports, and settings also had no horizontal overflow at 390 px.
- Browser routes loaded without alert states:
  - workbench
  - George GBP Post task
  - reviews and causal analysis
  - reports and data
  - settings and runtime controls
- George GBP workflow exposes generation/regeneration, operator copy/photo replacement, immutable draft history, finalization/reopen controls, approval gates, hold, immediate publication confirmation, and scheduled publication.
- Kubernetes UAT manifests rendered and passed client-side dry-run for 10 resources: namespace, config map, PVC, two services, four deployments, and ingress.

### Canonical portfolio correction

- Only Bear merchant: `8cafe7c9-192c-4e6f-98ef-779dead98de2`
- Only Bear Mineola location: `c320bf5f-9d54-4d96-814b-cc50cf565a27`
- Only Bear creation independently read back one Planner Task and the exact website/place identity supplied by the approved bootstrap material.
- Legacy placeholder slug `george-merchant-uws` is excluded from the operator portfolio without deleting its audit history.
- Canonical George merchant: `78ba2ea2-1914-401e-92d7-bfb1f08a5dad`
- Canonical George location: `8a4684e1-39f7-4a37-8a9b-cd8cbacdadd3` (`ghc1 · Youngstown, OH`).

### Retained pre-Gate Core AI content readback

The following run proves the generated-draft/revision adapter against the retained legacy record. It is not counted as one of the four canonical portfolio merchants and is not accepted as GBP execution proof.

- Merchant: `8e4e3ee4-6bfa-4fd4-8f1d-9619c3e68e29`
- Location: `6edcec91-af7a-4fe9-8fa7-f9a5256acc2d`
- Task: `c50ebd98-e59a-4d9d-a0d9-d3e6de6de89e`
- Latest SEO Ops Agent Run: `24c63f30-b193-467e-b50e-7ccee974460b`
- Latest Core AI Run: `4bc9eae4-e720-4ec2-97d8-04da2604b70b`
- Latest trace: `0961fbf1e343874c64243a27ad665577`
- Latest persisted draft: `d2d30d92-879f-487a-99ca-ee571ef24c53` (`v4`)
- Latest image deliverable: `24c63f30-b193-467e-b50e-7ccee974460b-att-6a2c7766-c56b-4cd2-8d2c-0ffc23804d00`
- Independent Task readback: `NEEDS_INPUT`, state version `11`, Task revision `9`.
- Persisted draft readback: four immutable Agent-generated versions; latest body hash `94220b9079bcd67e70e0f34a75163880c4731b81019708e6146b54ce5bd1f209` and image hash `sha256:6017cc11714f5807523dc90bf2de4e1d0c6b39dbf10b12ed10ed02d04d34c5ff`.
- No Gate 2 command was confirmed during acceptance, so no new GBP resource identity is claimed.

### Canonical UWS publication-boundary readback

- Approved task: `aa159b42-bfed-45c6-8b51-1779535b4536`
- Merchant/location: `8aa82114-0314-49b2-9c15-523090f47194` / `3bb4fb95-37ac-410a-8617-7abac693b8b2`
- Task readback: `APPROVED`, state version `5`, Task revision `3`.
- Gate 2 readback: `available=false`, binding state version `0`.
- The exact Core service identity, logical credential refs, strict write/readback Agent coordinates, and READY binding are absent. The UI disables immediate and scheduled publication, and the server rejects execution. This is an external configuration blocker, not a successful publication path.

## Safety and external-state boundaries

- Real GBP publication: **NOT EXECUTED BY DESIGN**. Acceptance did not click immediate or scheduled publication; external write still requires explicit operator Gate 2 confirmation.
- Core AI source repository: **NOT MODIFIED**.
- FBR Project source repository: **NOT MODIFIED**.
- Content Agent binding fails closed unless the server independently reads back the exact published draft-only Agent policy.
- Global and per-merchant pause controls stop new claims/dispatches while allowing in-flight result convergence.

## Blocked environmental checks

- Docker image build: **BLOCKED — DOCKER DAEMON UNAVAILABLE**. The installed client cannot connect to the local Docker daemon.
- `npm audit`: **BLOCKED — REGISTRY ENDPOINT UNAVAILABLE**. The configured npmmirror registry returns `404 NOT_IMPLEMENTED` for the npm advisory endpoint in both workspaces.
- Canonical George/UWS automatic GBP publication: **BLOCKED — EXACT GATE 2 BINDING UNAVAILABLE**. The current Core AI API key resolves to a human identity rather than the required `api:<uuid>` service identity, and no mounted write/readback credential references or strict execution/readback Agent coordinates are configured. No placeholder value was invented.

These two blocked checks are not recorded as passes and must be repeated in CI or on a host with a running Docker daemon and an advisory-capable npm registry before UAT deployment approval.
