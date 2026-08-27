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
  - George Merchant · 2020 Broadway
  - George · ghc1
  - Keke Food · Flushing NY
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

### Safe George Core AI UAT readback

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

## Safety and external-state boundaries

- Real GBP publication: **NOT EXECUTED BY DESIGN**. Acceptance did not click immediate or scheduled publication; external write still requires explicit operator Gate 2 confirmation.
- Core AI source repository: **NOT MODIFIED**.
- FBR Project source repository: **NOT MODIFIED**.
- Content Agent binding fails closed unless the server independently reads back the exact published draft-only Agent policy.
- Global and per-merchant pause controls stop new claims/dispatches while allowing in-flight result convergence.

## Blocked environmental checks

- Docker image build: **BLOCKED — DOCKER DAEMON UNAVAILABLE**. The installed client cannot connect to the local Docker daemon.
- `npm audit`: **BLOCKED — REGISTRY ENDPOINT UNAVAILABLE**. The configured npmmirror registry returns `404 NOT_IMPLEMENTED` for the npm advisory endpoint in both workspaces.

These two blocked checks are not recorded as passes and must be repeated in CI or on a host with a running Docker daemon and an advisory-capable npm registry before UAT deployment approval.
