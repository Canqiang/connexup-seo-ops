# Local Falcon Keyword Ranking Design

## Objective

Expose the existing read-only Local Falcon reports already available through Core AI in the merchant keyword view. Operators should see precise Local Falcon metrics and inspect a geographic rank grid without confusing an average grid rank with a single Local Pack position.

## Repository and mutation boundary

- Modify only `/Users/xander/git_repo/connexup-seo-ops`.
- Core AI and the Local Falcon MCP remain external capability providers and are not modified.
- The default action only lists and reads existing Local Falcon reports. It never calls `runLocalFalconScan`, `runLocalFalconCampaign`, or another credit-consuming tool.
- A future credit-consuming scan action must be a separate control with explicit cost disclosure and confirmation; it is out of scope for this slice.

## Verified upstream capability

The UAT Ranking Agent already includes an enabled MCP server named `local-falcon`. SEO Ops uses the authenticated Core AI server-side adapter to call only:

- `listLocalFalconScanReports` to find the latest exact-keyword Google report for a merchant Place ID.
- `getLocalFalconReport` to read a compact field mask containing report identity, scan settings, ARP, ATRP, SoLV, image links, and rank-only grid points.

The browser never calls Core AI or Local Falcon directly. The MCP server ID is configured through `COREAI_LOCAL_FALCON_TOOL_ID`.

## Data model

Keep the current Agent-authored `seo_ops.ranking_report.v1` unchanged because the published Core AI Agent contract is external and read-only. Add a separate SEO Ops-owned snapshot model:

- `report_key`, `place_id`, `keyword`, `platform`, and scan timestamp.
- `arp`, `atrp`, and `solv` as source-reported decimals.
- `grid_size`, `radius`, `measurement`, center latitude/longitude, and `found_in`.
- A compact list of `{lat, lng, found, rank}` grid points; competitor result payloads are never requested or stored.
- Optional Local Falcon image and heatmap URLs as source references.

Persist one row per Local Falcon `report_key`. A re-sync updates that row in place and preserves other historical reports. The SEO target state returns the latest snapshot for every exact keyword in the accepted keyword set.

## Synchronization flow

`POST /api/merchants/{merchantId}/local-falcon-sync`:

1. Requires a synchronized GBP profile with a Google Place ID and a ready keyword set.
2. Considers only accepted `LOCAL` strategy keywords.
3. Lists reports using the exact Place ID plus each keyword, then accepts only a case-insensitive exact keyword match on platform `google`.
4. Reads the latest matching report with a compact field mask.
5. Validates grid dimensions, numeric metrics, report identity, and point count before one atomic upsert.
6. Returns the normal SEO target state with `local_falcon` synchronization metadata and snapshots.

Missing reports are truthful gaps, not errors and never trigger a new scan. A Core AI/MCP failure returns a safe 502/503 response and leaves previous snapshots intact.

## Metric semantics

- **ARP** is the merchant's average rank across valid grid points and retains decimals.
- **ATRP** is the average total rank position reported by Local Falcon.
- **SoLV** is the percentage of valid grid points where the merchant ranks in the top three.
- **Local Pack rank** from DataForSEO remains a separate single-location result. It is never compared or merged numerically with ARP.
- Trend deltas are shown only when keyword, grid size, radius, measurement, and center coordinates match. Trend calculation is deferred until at least two comparable persisted snapshots exist.

## User experience

The keyword table remains compact. It shows keyword, strategy, priority, source, Local Pack rank, ARP, SoLV, organic rank, and scan date. Rows with a Local Falcon snapshot are clickable and expose a single inline detail panel below the table rather than navigating away.

The detail panel contains:

- ARP, ATRP, SoLV, grid size/radius, and scan time.
- A locally rendered square rank grid ordered north-to-south and west-to-east.
- Rank cells colored by bands: 1-3 strong, 4-10 moderate, 11-20 weak, and not found.
- A short legend and the source report key.

The action is labeled `同步已有 Local Falcon 报告`, which makes the read-only behavior explicit. No paid-scan control appears in this slice.

## Acceptance criteria

- UWS exact-keyword Local Falcon reports can be synchronized through Core AI without creating scans.
- ARP remains decimal and SoLV/ATRP are not lost.
- The UI clearly separates Local Falcon grid metrics from DataForSEO Local Pack and organic ranks.
- A synchronized 9x9 report renders 81 ordered rank cells and a truthful legend.
- Missing reports, unavailable configuration, partial upstream data, and sync failure retain the last successful local snapshots.
- Backend and frontend tests, lint, and build pass without modifying another repository.
