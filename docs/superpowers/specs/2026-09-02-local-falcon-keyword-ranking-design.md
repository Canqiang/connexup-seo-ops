# Local Falcon Keyword Ranking Design

## Objective

Expose the merchant's persisted keywords, existing Local Falcon reports, and an approval-controlled Top 20 scan workflow in one merchant keyword view. Operators should see precise metrics, explicitly regenerate and re-score keywords when needed, approve an immutable scored cohort, and separately confirm any credit-consuming scan batch.

## Repository and mutation boundary

- Modify only `/Users/xander/git_repo/connexup-seo-ops`.
- Core AI and the Local Falcon MCP remain external capability providers and are not modified.
- Reading existing reports remains a separate, non-credit-consuming action.
- Persisted FBR keywords are the default source of truth. Page load, GBP synchronization, and Local Falcon synchronization never generate or replace keywords.
- Regeneration is a distinct operator action and must use the configured Seed Skill followed by the configured Ranking Skill. Agent configuration alone is not execution evidence.
- `runLocalFalconScan` is allowed only after a scored keyword artifact is hashed, its Top 20 cohort is approved by the authenticated operator, and the operator confirms credit spend in a second action.
- Campaign tools remain out of scope. An uncertain scan response is never automatically retried because the upstream tool has no idempotency key.

## Verified upstream capability

The UAT integration exposes these Local Falcon tools through the authenticated Core AI server-side adapter:

- `listLocalFalconScanReports` to find the latest exact-keyword Google report for a merchant Place ID.
- `getLocalFalconReport` to read a compact field mask containing report identity, scan settings, ARP, ATRP, SoLV, image links, and rank-only grid points.
- `runLocalFalconScan` to submit one operator-confirmed Google grid scan using explicit Place ID, center, grid, radius, and measurement parameters.

The browser never calls Core AI or Local Falcon directly. The MCP server ID is configured through `COREAI_LOCAL_FALCON_TOOL_ID`.

## Keyword source and regeneration contract

SEO Ops exposes two intentionally separate operations:

1. **Read persisted keywords** reads the FBR keyword repository for the selected Google Place ID. When records exist, they are normalized and persisted as `PERSISTED_FBR_READBACK`; no Agent run is started.
2. **Regenerate keywords and scores** is an explicit operator action. It starts the dedicated keyword workflow with the configured Seed and Ranking Skill IDs and snapshots each Skill's ID, qualified name, version, and update time in the request.

Generated output is accepted only after Core AI runtime evidence proves the dedicated Agent loaded the requested workflow instructions. SEO Ops reads the completed trace and the detailed `use_skill` spans, then requires:

- exactly one successful invocation of the frozen Seed Skill;
- exactly one successful invocation of the frozen Ranking Skill;
- Seed completion before Ranking starts;
- the trace Agent and run identity to match the requested generation;
- the accepted artifact hash to match the persisted output.

Missing, duplicate, failed, out-of-order, or unverifiable spans fail closed. Declared Agent `skill_ids`, a completed run status, or syntactically valid JSON is not sufficient proof. The stored provenance records span IDs and hashes of span inputs/outputs. Because Core AI Skills are Agent instructions rather than independently executed functions, the trace proves the exact Skills were loaded in order but does not cryptographically prove how the Agent derived each score; the separate operator approval remains mandatory before any Local Falcon spend.

Every `LOCAL` keyword must have a finite numeric score before cohort selection. SEO Ops sorts scores descending and preserves source order as the deterministic tie-breaker, assigns `score_rank`, case-insensitively removes duplicate keyword text, and selects at most ranks 1 through 20. DataForSEO may supply separately labeled ranking evidence, but DataForSEO keywords never replace the persisted or Skill-generated keyword set.

## Data model

Keep the current Agent-authored `seo_ops.ranking_report.v1` unchanged because the published Core AI Agent contract is external and read-only. Add a separate SEO Ops-owned snapshot model:

- `report_key`, `place_id`, `keyword`, `platform`, and scan timestamp.
- `arp`, `atrp`, and `solv` as source-reported decimals.
- `grid_size`, `radius`, `measurement`, center latitude/longitude, and `found_in`.
- A compact list of `{lat, lng, found, rank}` grid points; competitor result payloads are never requested or stored.
- Optional Local Falcon image and heatmap URLs as source references.

Persist one row per Local Falcon `report_key`. A re-sync updates that row in place and preserves other historical reports. The SEO target state returns the latest snapshot for every exact keyword in the accepted keyword set.

Persist approvals separately from scan execution:

- An approval stores the exact keyword artifact ID, canonical Top 20 SHA-256, keyword/score/rank snapshot, Place ID, operator, and timestamp.
- A paid confirmation separately binds one stable request ID to the approval, canonical scan-parameter JSON/SHA-256, authenticated operator, and confirmation timestamp.
- A scan batch has a one-to-one reference to that paid confirmation and stores per-keyword submission state. The confirmation and initial batch/items are committed in the same immediate transaction before any remote call.
- A durable worker atomically claims the persisted batch. Per-keyword state is written as `submitting` before the remote call and the worker heartbeat prevents a stale worker from overwriting later state.
- A transport-uncertain result becomes `unknown`; an acknowledged prefix followed by uncertainty becomes `partial`. The same request ID returns the stored batch and never resubmits it.
- Generated keyword artifacts additionally persist the frozen Skill workflow request and verified trace provenance. This provenance is required for approval and paid eligibility.

## Synchronization flow

`POST /api/merchants/{merchantId}/local-falcon-sync`:

1. Requires a synchronized GBP profile with a Google Place ID and a ready keyword set.
2. Considers only accepted `LOCAL` strategy keywords.
3. Lists reports using the exact Place ID plus each keyword, then accepts only a case-insensitive exact keyword match on platform `google`.
4. Reads the latest matching report with a compact field mask.
5. Validates grid dimensions, numeric metrics, report identity, and point count before one atomic upsert.
6. Returns the normal SEO target state with `local_falcon` synchronization metadata and snapshots.

Missing reports are truthful gaps, not errors and never trigger a new scan. A Core AI/MCP failure returns a safe 502/503 response and leaves previous snapshots intact.

## Approval-controlled scan flow

1. `POST /api/merchants/{merchantId}/local-falcon-approvals` receives the displayed keyword artifact ID and cohort SHA-256.
2. The API recalculates the scored Top 20 and rejects stale or unscored cohorts before persisting the operator approval.
3. `POST /api/merchants/{merchantId}/local-falcon-scan-batches` requires the approval ID, a stable operator request ID, the displayed scan-parameter SHA-256, and `confirm_credit_spend=true`.
4. The API revalidates that the approval still matches the latest keyword artifact and current GBP Place ID, then persists one paid confirmation and one batch for that request ID.
5. Scan parameters are reused only from a previously persisted report for the same Place ID; absent or changed parameters block submission instead of inventing coordinates.
6. The HTTP request commits the confirmation, batch, and all pending items, then returns without spending credits. A durable worker claims and dispatches the batch.
7. Each keyword is submitted once. A valid acknowledged report key is stored with the item. Existing-report synchronization marks it complete only when that exact key returns with matching Place ID, keyword, grid, radius, measurement, and center coordinates.

## Uncertain batch reconciliation

Paid submissions are not safe to retry when the upstream response is uncertain. Therefore `unknown` and `partial` are locked states, not retry queues:

- the UI shows the persisted batch summary and clearly labels that manual reconciliation is required;
- keyword regeneration, a new approval, and another paid batch remain blocked while the batch is unresolved;
- background polling may read current state and acknowledged reports, but it never repeats `runLocalFalconScan`;
- an authenticated operator must reconcile upstream report keys and the frozen keyword/configuration snapshot before the batch can be closed or further work can continue;
- reconciliation decisions must be auditable and must not convert an unknown submission into an automatic retry.

## Metric semantics

- **ARP** is the merchant's average rank across valid grid points and retains decimals.
- **ATRP** is the average total rank position reported by Local Falcon.
- **SoLV** is the percentage of valid grid points where the merchant ranks in the top three.
- **Local Pack rank** from DataForSEO remains a separate single-location result. It is never compared or merged numerically with ARP.
- Trend deltas are shown only when keyword, grid size, radius, measurement, and center coordinates match. Trend calculation is deferred until at least two comparable persisted snapshots exist.

## User experience

The keyword table remains compact and lives in a fixed-height scroll region. It shows the full keyword set without expanding the page. Each row includes its score/score rank, a small locally rendered heatmap, ARP, ATRP, SoLV, and separately labeled Local Pack and organic ranks. Batch state is summarized by default; per-keyword submission details do not open automatically.

The heatmap column header carries a persistent text-and-color legend for `1-3`, `4-5`, `6-10`, `11+`, and not found. Each report row renders its exact ordered point count as an accessible miniature grid. Metrics and scan parameters stay in the same row, so there is no inline expansion or separate drawer and the operator remains in one compact table context.

Primary controls reflect three distinct operations: read FBR persisted keywords, explicitly regenerate and score keywords through the Skills, and generate/update reports for the approved Top 20. Existing-report synchronization remains a non-credit-consuming secondary action. The paid action always opens a confirmation dialog showing the merchant address, Place ID, center, grid/radius/measurement, exact cohort, and credit warning before either approval or submission is sent.

## Acceptance criteria

- UWS exact-keyword Local Falcon reports can be synchronized through Core AI without creating scans.
- ARP remains decimal and SoLV/ATRP are not lost.
- The UI clearly separates Local Falcon grid metrics from DataForSEO Local Pack and organic ranks.
- A synchronized 9x9 report renders 81 ordered rank cells and a truthful legend.
- Persisted FBR keywords are used without an Agent run; only an explicit regenerate action starts the Seed and Ranking Skill workflow.
- A generated artifact is not trusted unless detailed runtime trace evidence proves both frozen Skills ran exactly once, successfully, and in order.
- Scored local keywords are deterministically ranked and only the unique Top 20 are eligible for Local Falcon approval.
- Missing reports, unavailable configuration, partial upstream data, and sync failure retain the last successful local snapshots.
- An unscored keyword artifact cannot be approved or scanned.
- A stale cohort hash cannot be approved, and an approval becomes unusable when the latest keyword artifact changes.
- A repeated scan request ID cannot submit duplicate paid scans; an uncertain submission is visible as `unknown` and is never automatically retried.
- A partial or unknown paid batch blocks regeneration and further paid work until an authenticated, auditable manual reconciliation resolves it.
- A scan batch is completed only through exact acknowledged-report readback; an older report or a matching timestamp alone is insufficient.
- The keyword table and batch summary do not expand; each report's exact grid is represented by its accessible miniature heatmap in the row.
- Backend and frontend tests, lint, and build pass without modifying another repository.
