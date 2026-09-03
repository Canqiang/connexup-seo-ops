# Local Keyword Store and FBR Import Design

## Objective

Make the SEO Ops database the normal source of truth for keyword display and downstream workflows. Skill generation and explicit FBR reads both create durable local keyword versions. A later FBR read must not silently replace the active Skill-scored version.

For the current UWS data, the existing verified Skill artifact `12` with 16 keywords becomes active. The 19-keyword Skill artifact and the 101-keyword FBR artifacts remain available as history; none are deleted.

## Boundaries

- Modify only `/Users/xander/git_repo/connexup-seo-ops`.
- Do not change or deploy FBR, Core AI, or Local Falcon services.
- Do not add any FBR keyword write or publication flow.
- Keep the existing explicit FBR read endpoint as an import source.
- Page load and all normal keyword queries read only the SEO Ops database.
- This design supersedes the earlier rule that persisted FBR keywords are the default source of truth in `2026-09-02-local-falcon-keyword-ranking-design.md`. Its Skill provenance, Local Falcon approval, scan, reconciliation, and metric rules remain in force.

## Canonical local model

Continue using `merchant_seo_artifacts` as the immutable keyword version store. Every successful Skill generation and every explicit FBR import persists a separate ready `KEYWORD_SET` artifact with its source, Place ID, payload, creation time, and completion time.

Add `merchant_keyword_heads`, keyed by `(merchant_id, place_id)`, with:

- `active_artifact_id`: the one keyword artifact used by the page and downstream workflows;
- `activated_by`: authenticated operator, `system-skill-workflow`, or `system-bootstrap`;
- `activation_reason`: Skill generation, first bootstrap, explicit restore, or explicit FBR adoption;
- `activated_at` and `updated_at`.

The active artifact must be a ready `KEYWORD_SET` for the same merchant and exact Place ID. The foreign key prevents an active artifact from being deleted. A compare-and-set update prevents a stale browser or concurrent workflow from changing a newer head.

No second keyword payload table is introduced. Artifacts hold complete versions; the head records only which version is current.

## Bootstrap existing data

Create missing heads lazily and idempotently:

1. Resolve the merchant's selected GBP Place ID.
2. Find ready keyword artifacts for the same merchant and Place ID.
3. Prefer the newest trusted, fully scored Skill artifact with verified provenance.
4. If no trusted Skill artifact exists, use the newest ready FBR artifact.
5. Never activate an artifact for another Place ID.

For UWS, this selects artifact `12`, not the newer FBR artifacts `13` or `14`. The migration is data-driven and does not hard-code those IDs.

## Normal read flow

`GET /api/merchants/{merchantId}/seo-targets` reads the local head, then returns that exact artifact. It does not contact FBR and does not select the newest inserted artifact.

The response adds:

- `active_keyword_artifact_id`;
- `active_keyword_source`;
- `active_keyword_activated_at`;
- `keyword_versions`, with artifact ID, source, Place ID, count, score completeness, completion time, and `is_active`;
- the latest FBR import comparison when one exists.

Local Falcon cohort selection, approval hashes, existing-report synchronization, and paid scan generation all use the active artifact. They reject a request that names a different or stale artifact.

## Skill generation flow

1. Run the existing Seed and Ranking Skill workflow.
2. Apply the existing strict output, location, score, ranking, and trace-provenance validation.
3. Persist the complete ready artifact locally, including Local and Organic strategies, Skill scores, score ranks, source tags, rationale, and provenance.
4. In the same transaction that marks the artifact ready, move the matching local head to the new artifact.
5. Return the new active state from the local database.

A failed, stale, location-mismatched, unscored, or provenance-unverified result does not move the head. The last valid active version remains visible.

## Explicit FBR import flow

Keep the operator action `从 FBR 重新读取`, but treat it as an import rather than a default read.

1. Claim a keyword import cycle without changing the active head.
2. Fetch FBR Local keywords for the exact selected Place ID.
3. Normalize and persist the returned set as a new immutable `PERSISTED_FBR_READBACK` artifact in SEO Ops.
4. Compare the imported Local artifact only with the active artifact's Local subset, using canonical keyword identity, priority, and target surfaces. Organic keywords are outside this FBR endpoint and are never counted as removed.
5. Return added, removed, and changed counts and retain both versions.
6. Keep the current head unchanged.

If FBR is unavailable, malformed, empty, or returns another Place ID, the import fails and the active local version is untouched. Repeating an unchanged FBR import may create a new audit version, but it does not affect what the page displays.

## Explicit version activation

Add `POST /api/merchants/{merchantId}/seo-targets/activations` with:

- target artifact ID;
- expected current active artifact ID;
- confirmation that the operator reviewed the source and score status.

The API verifies the authenticated operator, merchant, exact Place ID, ready status, and compare-and-set head before activation. It returns the normal local SEO target state.

The UI action is labeled according to intent:

- `恢复这个 Skill 版本` for a previous generated artifact;
- `采用这个 FBR 版本` for an imported artifact.

Adopting an FBR version requires a warning that FBR currently does not provide Skill scores. The active Local Falcon cohort becomes unavailable until the operator restores or generates a fully scored trusted version.

## User experience

The keyword header clearly separates the active local version from the latest import:

- `SEO Ops 当前版本 · Skill · 16 个关键词（Local 10 / Organic 6）· 评分已验证`
- `最新 FBR Local 导入 · 101 个关键词 · 未采用`

Primary actions remain:

- `重新生成关键词并评分`;
- `审批并生成 Top 20 报告` when the active version is eligible.

Secondary actions become:

- `从 FBR 重新读取`;
- `查看版本`;
- `只同步已有报告`.

After an FBR import, show a comparison panel with the active Local count, FBR Local count, additions, removals, priority changes, and target-surface changes. The active total and its Local/Organic split remain separately visible. The table continues to show the active local version until the operator explicitly adopts another version.

The version panel is compact and lists source, count, score status, time, and active state. Restoring or adopting always opens a confirmation dialog. No page load, polling request, GBP synchronization, or Local Falcon synchronization changes the active keyword head.

## Concurrency and failure handling

- Head updates use a compare-and-set condition on the expected active artifact ID.
- Skill completion activates only its own artifact and exact Place ID.
- FBR import never activates implicitly.
- Remote FBR I/O occurs without holding a SQLite transaction.
- Existing unresolved Local Falcon batches continue to block regeneration and head changes where cohort identity must remain frozen.
- Any failed generation, import, or activation preserves the last valid active version.
- Error messages distinguish local persistence failure, FBR import failure, and stale activation conflict.

## API compatibility

Keep `POST /api/merchants/{merchantId}/seo-targets/refresh` as the FBR import endpoint so existing clients continue to work. Its changed contract is intentional: it persists a candidate version and comparison but no longer changes the active version.

The frontend keeps calling the route from `从 FBR 重新读取`. The returned state must include the unchanged active artifact plus the newly imported version metadata.

## Testing strategy

Backend tests must prove:

- bootstrap prefers a trusted scored Skill artifact over a newer unscored FBR artifact;
- UWS resolves artifact `12` as active without deleting artifacts `11`, `13`, or `14`;
- normal GET reads the active artifact and performs no FBR call;
- successful verified Skill completion atomically activates its new artifact;
- failed or unverified Skill completion preserves the previous head;
- FBR refresh persists a new candidate and comparison without moving the head;
- FBR failure, empty data, malformed data, and Place ID mismatch preserve the head;
- explicit activation validates merchant, Place ID, ready status, operator, and expected previous head;
- concurrent or stale activation fails closed;
- Local Falcon approval and scans use the active artifact rather than the latest inserted artifact.

Frontend tests must prove:

- a later 101-keyword FBR import does not replace the displayed 16-keyword active Skill set;
- active source/count/score status and latest FBR import status are separately labeled;
- the comparison panel compares FBR Local only with the active Local subset and shows exact counts;
- adopting an unscored FBR version requires explicit confirmation;
- a stale activation response leaves the visible active version unchanged;
- page load and polling never trigger FBR keyword reads.

Run focused backend and frontend tests first, followed by the complete API suite, complete web suite, lint, and production build. Manual verification must read the active head directly from SQLite and confirm that the browser still shows 16 scored keywords after `从 FBR 重新读取` returns 101.

## Acceptance criteria

- Keywords, scores, ranks, and provenance are durable in the SEO Ops database.
- Exactly one keyword artifact is active per merchant and Place ID.
- The UWS active state uses the existing 16-keyword Skill artifact.
- Normal page reads use only the local database.
- `从 FBR 重新读取` remains available and saves a new local candidate version.
- FBR imports never silently replace the active version.
- Operators can explicitly restore a Skill version or adopt an FBR version.
- Local Falcon workflows use the explicit active artifact and reject stale hashes.
- All keyword versions remain auditable and no existing 19-, 16-, or 101-keyword artifact is deleted.
- The implementation changes no FBR data and introduces no FBR write path.
