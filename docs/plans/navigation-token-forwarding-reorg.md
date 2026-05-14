# Navigation, Token, And Forwarding Reorg Plan

## Goal

Make the product workflow match the operational model:

- Link management keeps upstream sites, signed-in accounts, and direct API Key connections healthy.
- Account token management owns site-generated or synced account tokens used by routing.
- Forwarding configuration owns downstream keys and their routing policy.
- Model groups and site pools become the shared policy primitives instead of scattered advanced fields.

## Current Problem

The current "connection management" page mixes several jobs:

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

Primary route: `/accounts` for the first slice.

Owns:

- Session account list.
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

First UI shape:

- Keep the existing token table and actions.
- Preserve existing deep links where possible:
  - `/accounts?segment=tokens` should redirect to `/tokens`.
  - `/accounts?segment=apikey` should stay in link management.

### Forwarding Configuration

Primary route: `/downstream-keys`, renamed in navigation to "转发配置" or "下游转发".

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
- Replacement for "exclude sites" style advanced settings.

## First Implementation Slice

Keep this slice mostly frontend-only and low-risk.

1. Update navigation labels and grouping:
   - `/accounts`: "链接管理".
   - `/tokens`: "账户令牌".
   - `/downstream-keys`: "转发配置".
   - Keep `/model-groups` and `/site-pools` visible as policy primitives.

2. Change `/accounts` behavior:
   - Remove the "账号令牌管理" tab from the page.
   - Keep both Session account maintenance and API Key connections in this page.
   - Treat API Key as a fallback account form for sites where username/password or Session login is unavailable.
   - Preserve check-in, refresh health, balance, rebind, and edit flows.

3. Change `/tokens` behavior:
   - Stop redirecting `/tokens` back into `/accounts?segment=tokens`.
   - Render the token management panel directly.
   - Keep it focused on account token CRUD/sync/default binding.
   - Show token runtime state and available model preview.
   - Allow triggering model availability checks from token rows.

4. Preserve compatibility redirects:
   - `/accounts?segment=tokens` -> `/tokens`.
   - `/accounts?segment=apikey` remains on `/accounts`.

5. Update tests:
   - Sidebar source test expectations.
   - Account segment tests that assume tokens live under `/accounts`.
   - Token redirect tests.
   - Any mobile navigation tests affected by label changes.

6. Verify:
   - `npm run typecheck:web`
   - focused navigation and page tests
   - browser smoke check on local `http://127.0.0.1:4120/`

## Acceptance Criteria

- Link management no longer presents account token management as a same-level tab.
- Link management still presents Session and API Key account connection modes.
- Account token management is reachable as a first-class menu item.
- Account token management shows whether each token is usable and which large models are currently available.
- Direct API Key connections are conceptually grouped with account management as a login fallback.
- Downstream key policy is reached through "转发配置".
- Existing deep links do not land users on a broken page.
- No backend data model changes are required for this first slice.

## Later Slices

- Extract shared connection add/edit components so Session and API Key account modes stay maintainable without duplicating account logic.
- Rename backend-facing labels only after frontend IA is stable.
- Add a policy overview to forwarding configuration showing downstream key -> model groups -> site pools -> callable upstream channels.
- Remove legacy model whitelist copy from downstream key editors after migration support is complete.
- Surface Sub2API managed refresh state in account details, including last refresh result and next refresh time.
