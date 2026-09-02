# Merchant GBP Profile Design

## Objective

Add a read-only merchant profile view to SEO Ops so an internal operator can inspect the FBR merchant identity and the latest persisted Google Business Profile facts without leaving the operations console.

## Repository boundary

- Modify only `/Users/xander/git_repo/connexup-seo-ops`.
- Treat `/Users/xander/git_repo/fbr-project`, `/Users/xander/git_repo/core-ai`, and `/Users/xander/git_repo/fbr-agent` as read-only external systems.
- Never copy, persist, return, log, or render GBP OAuth access tokens or refresh tokens.
- SEO Ops may persist external resource IDs, read-only GBP payload snapshots, synchronization state, and source timestamps.

## Source contract

The FBR SEO Integration service is the source of truth for current GBP data:

- `GET /google-business-profile?merchant_id={fbrMerchantId}` lists GBP locations.
- `GET /google-business-profile/{gbpLocationId}/field/{field}?merchant_id={fbrMerchantId}` returns one raw JSON field and its source `updated_time`.
- Supported fields are `LOCATION`, `ATTRIBUTES`, `FOOD_MENUS`, `LOCAL_POSTS`, `MEDIA`, `CUSTOMER_MEDIA`, `QUESTIONS`, `PLACE_ACTION_LINKS`, and `VERIFICATIONS`.

The backend calls this service only when explicitly asked to synchronize. The frontend never calls FBR directly. `FBR_SEO_BASE_URL` configures the internal service base URL; `FBR_SEO_BEARER_TOKEN` is optional and is used only as an outbound header, never stored in SQLite or returned by an API.

## Local read model

`merchant_fbr_links` stores the explicit mapping between an SEO Ops merchant and an FBR merchant. `merchant_gbp_profiles` stores the latest synchronized read-only snapshot per GBP location. The full source field payloads are retained as JSON text for traceability, while a normalized summary is returned to the UI.

Binding and synchronization are separate operations:

1. An operator saves the exact FBR merchant ID.
2. SEO Ops marks the link `not_synced` and removes no historical evidence.
3. The operator selects “同步 GBP 资料”.
4. The backend lists FBR GBP locations, fetches available fields, validates JSON, and atomically replaces the current per-location cache.
5. A failed synchronization keeps the last successful snapshot and records a safe error message.

## API

- `GET /api/merchants/{merchantId}/profile` returns the link state and cached GBP locations. An unbound merchant returns `state: "unbound"`, not 404.
- `PUT /api/merchants/{merchantId}/fbr-link` accepts `{ "fbr_merchant_id": "..." }`, saves the mapping, and returns `state: "not_synced"`.
- `POST /api/merchants/{merchantId}/gbp-sync` performs one read-only synchronization and returns the refreshed profile. It returns 409 for an unbound merchant and 503 when the FBR client is not configured or unavailable.

The response exposes only operationally useful facts: location identity, title, address, phone, website, categories, description, opening status, regular hours, counts of posts/media/questions, source update time, and synchronization time.

## User experience

Merchant pages share a small two-item local navigation: `运营` and `商户资料`.

`商户资料` has three states:

- **未绑定**: one short explanation and an FBR Merchant ID input.
- **已绑定，未同步/失败**: source identity, last error, and one “同步 GBP 资料” action.
- **已同步**: a location selector and one calm, full-width record view. Identity and contact facts are shown first; business description, categories, and hours follow. Source/update metadata is kept in a quiet footer.

The view is for desktop operations. It reuses the current porcelain-gray background, white surfaces, ink-blue text, blue informational accents, and orange write actions. It avoids decorative eyebrows, repeated cards, raw JSON, and technical IDs in the primary reading flow.

## Empty and failure behavior

- Missing optional GBP fields render as `未提供`, never as fabricated content.
- A location can still be shown when one or more FBR fields are unavailable.
- Sync errors explain that the last successful snapshot is preserved.
- An FBR merchant with no GBP locations renders a specific empty state.

## Out of scope

- Editing or publishing GBP data.
- OAuth authorization and credential management.
- Modifying FBR APIs or databases.
- Historical FBR snapshot browsing; the current FBR interface does not expose its weekly snapshot collection.
- Mobile layout work.

## Acceptance criteria

- An operator can bind an SEO Ops merchant to an FBR merchant ID.
- A configured backend can read current GBP data and cache it locally without external writes.
- The merchant profile page cleanly shows real cached GBP facts and their freshness.
- Unconfigured, unbound, empty, partial, and failed states remain usable and truthful.
- Existing merchant operations, audit snapshots, tasks, and navigation continue to work.
