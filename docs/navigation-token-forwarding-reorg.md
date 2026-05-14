# Navigation, Token, And Forwarding Reorg

## Goal

Make the product workflow match the operational model:

- Link management keeps upstream sites, signed-in accounts, and direct API Key connections healthy.
- Account token management owns site-generated or synced account tokens used by routing.
- Forwarding configuration owns downstream keys and their routing policy.
- Model groups and site pools become the shared policy primitives instead of scattered advanced fields.

## Current Problem

The current connection management page mixes several jobs:

- Session account maintenance: login state, check-in, balance, health.
- Direct API Key connections: fallback account connections when username/password or Session login is unavailable.
- Account tokens: site-generated or synced tokens used by routes.
- Model probing and route/channel operations.

That makes the main flow feel complicated. Users cannot quickly tell where to:

- Keep a site/account alive.
- Add a callable upstream key.
- Decide which models a downstream key can call.
- Decide which site pool a downstream key may use.

## Target Information Architecture

### Link Management

Primary route: `/accounts`.

Owns:

- Session account list.
- API Key account connections.
- Account health state.
- Check-in and balance refresh actions.
- Rebind or update account credentials.
- Site relationship display.

Does not own:

- Account token CRUD.
- Downstream key policy.
- Model group policy.
- Site pool policy.

### Account Token Management

Primary route: `/tokens`.

Owns:

- Synced/manual account tokens.
- Upstream token sync and token inventory.
- Default token and fixed token binding workflow.
- The token inventory used by forwarding routes.
- Token runtime status, model availability summary, and manual model availability probe entry points.

Deep-link behavior:

- `/accounts?segment=tokens` redirects to `/tokens`.
- `/accounts?segment=apikey` stays in link management.

### Forwarding Configuration

Primary route: `/downstream-keys`, shown in navigation as `转发配置`.

Owns:

- Downstream key creation and editing.
- Model group binding.
- Site pool binding.
- Quota, labels, grouping, and usage history.
- The user-facing policy surface for downstream clients.

Does not own:

- Upstream credential health.
- Check-in.
- Account balance.

### Model Groups

Primary route: `/model-groups`.

Owns:

- Public model group names.
- Exact, wildcard, and regex model matching.
- Source model membership.

Downstream keys should reference model groups, not legacy model whitelist fields.

### Site Pools

Primary route: `/site-pools`.

Owns:

- Site grouping for forwarding policy.
- Replacement for exclude-sites style advanced settings.

## Implemented First Slice

1. Updated navigation labels:
   - `/accounts`: `链接管理`.
   - `/tokens`: `账户令牌`.
   - `/downstream-keys`: `转发配置`.

2. Changed `/accounts` behavior:
   - Removed the account token management tab.
   - Kept both Session account maintenance and API Key connections.
   - Preserved check-in, refresh health, balance, rebind, and edit flows.

3. Changed `/tokens` behavior:
   - Stopped redirecting `/tokens` back into `/accounts?segment=tokens`.
   - Rendered token management directly.
   - Added token runtime state and available model preview.
   - Added per-token model availability checks.

4. Preserved compatibility redirects:
   - `/accounts?segment=tokens` -> `/tokens`.
   - `/accounts?segment=apikey` remains on `/accounts`.

5. Improved Sub2API managed refresh:
   - Expired Sub2API accounts with managed `refresh_token` are included in scheduled refresh.
   - Successful refresh writes back the new access token and restores the account to active.

## Implemented Follow-up Slice

The follow-up slice tightened the operator experience around health and observability without changing the overall IA:

1. Split account health into two visible surfaces on `/accounts`:
   - `API 状态`
   - `签到状态`

   This prevents check-in-only failures from visually implying that proxy forwarding is also broken.

2. Kept direct API Key connections inside link management, but made their status semantics clearer:
   - proxy-only connections default to API-forwarding health
   - unsupported check-in is shown as a separate non-error state

3. Simplified the dashboard observability section:
   - fixed three-column desktop layout
   - compact per-site cards
   - expandable 24h availability strip
   - per-site failed-reason summary chips

4. Downstream-key-aware route decision diagnostics were added at the API layer so forwarding policy debugging is aligned with:
   - allowed routes
   - site pools
   - excluded sites
   - excluded credentials

This keeps the new information architecture intact while making it much easier to answer:

- Is this account bad, or is only check-in bad?
- Is this site excluded by downstream policy, or is it actually unhealthy?
- Is the site mainly failing because of Cloudflare, auth expiry, upstream 5xx, or network timeouts?

## Acceptance Criteria

- Link management no longer presents account token management as a same-level tab.
- Link management still presents Session and API Key account connection modes.
- Account token management is reachable as a first-class menu item.
- Account token management shows whether each token is usable and which large models are currently available.
- Direct API Key connections are grouped with account management as a login fallback.
- Downstream key policy is reached through `转发配置`.
- Existing deep links do not land users on a broken page.
- No backend data model changes are required for this first slice.

## Later Slices

- Extract shared connection add/edit components so Session and API Key account modes stay maintainable without duplicating account logic.
- Rename backend-facing labels only after frontend IA is stable.
- Add a policy overview to forwarding configuration showing downstream key -> model groups -> site pools -> callable upstream channels.
- Remove legacy model whitelist copy from downstream key editors after migration support is complete.
- Surface Sub2API managed refresh state in account details, including last refresh result and next refresh time.
