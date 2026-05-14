# Metapi Custom Check-in And Routing Reliability Refactor Plan

## Objective

Make Metapi useful as a controllable upstream meta-gateway:

- Simple daily workflow: add upstream, verify, enable routing, enable check-in, and give clients one base URL with as few decisions as possible.
- Custom check-in flows per site/account, not only hard-coded platform adapter calls.
- A unified OpenAI/Claude/Gemini-compatible proxy for downstream clients.
- High route availability through explicit routing controls, transparent failover, health recovery, and explainable decisions.
- Debuggability when a site is usable but is not selected.

## Current Code Anchors

- Platform capability interface: `src/server/services/platforms/base.ts`
- Built-in platform adapters: `src/server/services/platforms/*.ts`
- Check-in execution: `src/server/services/checkinService.ts`
- Check-in API and schedule: `src/server/routes/api/checkin.ts`, `src/server/services/checkinScheduler.ts`
- Route selection and explanation: `src/server/services/tokenRouter.ts`
- Proxy channel selection: `src/server/proxy-core/channelSelection.ts`
- Endpoint fallback: `src/server/proxy-core/orchestration/endpointFlow.ts`
- Proxy logs/debug traces: `src/server/services/proxyLogStore.ts`, `src/server/services/proxyDebugTraceStore.ts`
- Schema: `src/server/db/schema.ts`, `drizzle/*`
- Admin API client: `src/web/api.ts`

## Guiding Decisions

- Keep Metapi as the base. The repo already has account/site/token models, route decisions, debug traces, cooldown, endpoint fallback, and scheduler infrastructure.
- Do not rewrite the proxy protocol layer first. The fragile user pain is control and diagnosis, not lack of proxy surfaces.
- Make the common path short. Advanced routing, token pools, model mappings, debug traces, and custom flows should be available, but not required to get a site working.
- Prefer progressive disclosure in the admin UI: quick setup first, advanced controls behind expandable sections.
- Add explicit capability declarations instead of inferring support from adapter defaults.
- Treat custom check-in as data plus a small execution engine, not as more platform-specific branches.
- Make route behavior observable before making it smarter.

## Current Delivery Status

Implemented in the current refactor slice:

- New API auto relogin now refreshes and persists the upstream `platformUserId` after a successful relogin, so balance refresh and check-in retries do not stay pinned to a stale user id.
- Routing and route explanation now accept downstream-key-aware policy context, so diagnostics reflect the real site pool, allowed routes, and excluded credentials used by a downstream key.
- Check-in failure and proxy usability are now treated as separate concerns in the product surface:
  - check-in-only degraded state is preserved for account maintenance
  - route selection no longer treats check-in-only degradation as a proxy routing blocker
- Account management now exposes separate `API 状态` and `签到状态` badges instead of one blended health badge.
- Dashboard site observability has been reduced to a denser tri-column card layout with per-site expand/collapse for the 24h strip.
- Site observability cards now include a lightweight failed-request reason summary, grouped into high-signal labels such as:
  - `Cloudflare / 验证`
  - `认证失效`
  - `上游 5xx`
  - `超时 / 网络`
  - `模型不支持`

This means the current slice already covers the most immediate operator pain:

- a usable site not being selected
- difficulty proving whether the blocker is routing policy, stale login state, or site instability
- check-in failures visually masking otherwise healthy API forwarding

## Phase 1: Simple Setup Workflow

Replace the current multi-page setup burden with one guided path.

Owner: product/web/backend

Dependencies: existing site/account/token/routes APIs, platform detection, model refresh workflow.

Target workflow:

1. Paste upstream URL.
2. Metapi detects platform and asks for either session token, API key, or username/password depending on capability.
3. Verify account/token immediately.
4. Fetch models and create default routes automatically.
5. Run one proxy test against a selected model.
6. Show the downstream base URL and API key.
7. Offer one toggle for auto check-in if supported or custom flow exists.

Implementation notes:

- Add a backend orchestration service instead of putting this logic in the page:
  - `setupUpstream(input)`
  - detect platform
  - create/update site
  - verify credential
  - create account/token
  - refresh model availability
  - rebuild default routes
  - run optional smoke test
- Add a compact "quick add upstream" UI that calls the orchestration service.
- Keep manual pages for advanced edits, but remove them from the default path.
- Add clear result states:
  - ready for proxy
  - check-in available
  - needs manual route selection
  - credential verified but no models found
  - upstream reachable but unsupported management API

Acceptance criteria:

- A normal OpenAI-compatible/API-key site can become usable for downstream clients in one flow.
- A New API-like account can be added, verified, routed, and check-in-enabled without visiting separate site/account/token/route pages.
- The final setup screen provides the exact base URL, key, and a tested model.
- Advanced configuration remains reachable but is not part of the happy path.

## Phase 2: Route Control And Diagnosis

Build the minimum tools to prove why a usable site is not selected.

Owner: routing/proxy

Dependencies: existing `tokenRouter.explainSelection`, debug trace store, downstream policy.

Implementation notes:

- Add a trusted manual override header for real downstream requests, separate from the current tester-only header:
  - `x-metapi-upstream-channel-id`
  - Optional later: `x-metapi-upstream-site-id`
- Gate override by admin setting and/or downstream API key permission.
- Extend route decision output to include:
  - site id, site status, account status, token id
  - source model, actual forwarded model
  - cooldown until, recent failure window, runtime breaker reason
  - downstream API key exclusion reason
- Store the route decision summary on proxy debug traces for failed and successful requests.
- Add a management API endpoint that explains a model under a specific downstream API key context.

Acceptance criteria:

- A request can force a specific channel and either use it or receive a precise reason it cannot be used.
- The UI/API can answer: "Why did site X not receive this request?"
- Existing tester forced-channel behavior remains local-only and unchanged.
- Tests cover forced channel, unavailable forced channel, downstream exclusion, cooldown, and source-model mismatch.

## Phase 3: Health Recovery And Availability Loop

Reduce cases where one transient failure keeps a usable site out of traffic.

Owner: routing/reliability

Dependencies: Phase 2 diagnostics; existing cooldown fields and `routeCooldownService`.

Implementation notes:

- Add a recovery probe job for cooled-down channels:
  - probe only channels with recent failures or cooldown
  - use the route source model when available
  - clear cooldown on successful probe
- Add per-site and per-channel manual recovery actions:
  - clear cooldown
  - reset runtime health
  - probe now
- Make failure classification shared between proxy retry and route health, so validation/model errors do not poison an entire site.
- Add a "minimum availability" fallback mode:
  - if every candidate is cooled down, allow one controlled retry against the least-bad candidate unless explicitly disabled.

Acceptance criteria:

- A temporarily broken site can automatically re-enter routing after a successful probe.
- Model-specific errors do not globally suppress unrelated models on the same site.
- The route decision explanation shows whether a candidate is blocked by stored cooldown, runtime breaker, or downstream policy.
- Tests cover recovery probe success/failure and all-candidates-cooling fallback.

## Phase 4: Custom Check-in Engine

Allow unsupported or unusual sites to check in without modifying TypeScript adapters.

Owner: check-in/platform

Dependencies: schema migration, account/site extra config conventions, scheduler.

Proposed data model:

- `checkin_flows`
  - `id`
  - `site_id`
  - `name`
  - `enabled`
  - `scope`: `site` | `account`
  - `steps_json`
  - `success_match_json`
  - `reward_extract_json`
  - `created_at`, `updated_at`
- Optional account override in `accounts.extraConfig.customCheckinFlowId`.

Flow shape:

```json
{
  "steps": [
    {
      "method": "POST",
      "path": "/api/user/checkin",
      "headers": {
        "Authorization": "Bearer {{accessToken}}"
      },
      "json": {}
    }
  ],
  "success": {
    "status": [200],
    "jsonPath": "$.success",
    "equals": true
  },
  "reward": {
    "jsonPath": "$.data.reward",
    "regex": "([0-9.]+)"
  }
}
```

Implementation notes:

- Add a small template resolver with a strict allowlist:
  - `baseUrl`, `accessToken`, `apiToken`, `platformUserId`, `username`, account/site extra config values.
- Support JSON response checks first; add regex/body matching only where necessary.
- Reuse `withAccountProxyOverride`.
- Preserve built-in adapter check-in as the default.
- Execution order:
  - account custom flow
  - site custom flow
  - built-in adapter check-in
- Log which flow ran and which step failed.

Acceptance criteria:

- A custom flow can check in a New API-like site without adding a new adapter file.
- A custom flow failure records the failing step and sanitized response snippet.
- Built-in check-in behavior stays compatible for existing sites.
- Tests cover template rendering, success matching, reward extraction, proxy override, and sensitive token redaction.

## Phase 4: Downstream Gateway Hardening

Make downstream clients see Metapi as a reliable single endpoint.

Owner: proxy/client-compat

Dependencies: Phase 2 and 3.

Implementation notes:

- Define a downstream API key capability model:
  - allowed models/routes
  - excluded sites/credentials
  - whether manual upstream override is allowed
  - request and cost limits
- Add a route dry-run endpoint:
  - input: model, client family, downstream key
  - output: route decision plus endpoint order
- Ensure streaming failures are logged with first-byte timeout and retry reason.
- Add route-level availability summary:
  - available channels
  - blocked channels by reason
  - last success/failure
  - next recovery time

Acceptance criteria:

- Cursor, Claude Code, Codex CLI, OpenAI SDK, and generic OpenAI-compatible clients can use one base URL.
- A downstream key can be constrained without accidentally hiding all viable routes.
- Failed proxy calls always leave enough trace data to diagnose routing, endpoint, and upstream response class.

## Phase 6: Admin UI Workflow

Expose the controls needed for day-to-day operation.

Owner: web/admin

Dependencies: backend APIs from Phases 1 to 4.

Implementation notes:

- Route detail page:
  - "Explain model" panel
  - force/probe/clear cooldown actions
  - candidate table grouped by site
- Quick setup page:
  - one input for upstream URL
  - credential panel chosen by detected platform capability
  - single "verify and enable" action
  - final connection card for downstream clients
- Site/account detail:
  - custom check-in flow editor
  - dry run check-in
  - last check-in result with failing step
- Proxy logs:
  - show selected channel/site and skipped-candidate summary
  - deep link to debug trace

Acceptance criteria:

- An operator can answer and fix "why did this request not hit site X?" from the UI.
- An operator can add a custom check-in flow and dry-run it before enabling.
- Common operations do not require editing database rows by hand.

## Navigation And Information Architecture Simplification

Current problem:

- The sidebar exposes too many implementation nouns at the same level: sites, announcements, connections, OAuth, downstream keys, check-in, routes, logs, monitor.
- The current `路由` page is not one concept. It mixes:
  - exposed model list
  - upstream channel candidates
  - route strategy
  - priority buckets
  - selection probability
  - group routes/model aliases
  - manual channel editing
  - cooldown clearing
  - site model blocking
  - route rebuild tasks
- This makes the product feel like a database/admin console instead of a gateway operator tool.

Recommended sidebar model:

- `概览`
  - dashboard, health, recent failures, quota/check-in summary.
- `接入上游`
  - quick add upstream, sites, accounts, API keys, OAuth accounts, site announcements.
- `对外服务`
  - downstream API keys, base URL, client integration, smoke tests.
- `模型与路由`
  - normal mode: exposed models and whether each model is usable.
  - advanced mode: route channels, priority buckets, group routes, forced routing, cooldown.
- `日志与诊断`
  - proxy logs, route explanation, debug traces, check-in logs, program events.
- `设置`
  - runtime settings, notification, import/export.

Recommended rename:

- `路由` -> `模型与路由`
- `连接管理` -> `上游账号`
- `下游密钥` -> `客户端接入`
- `使用日志` -> `请求日志`
- `签到记录` moves under `日志与诊断`, while check-in enablement lives on upstream setup/site/account pages.

Recommended `模型与路由` page modes:

- Default tab: `模型`
  - one row per exposed model
  - status: usable / partial / unavailable
  - available upstream sites count
  - last success/failure
  - primary action: test, explain, disable
- Second tab: `路由规则`
  - only group aliases and manual model mappings
  - create/edit external model names
- Third tab: `高级通道`
  - current detailed channel editor
  - priority buckets, probabilities, drag/drop, manual channel add/remove
  - clearly marked as advanced

Acceptance criteria:

- A new user can ignore the advanced channel editor and still use the product.
- The menu names answer user questions: "Where do I add upstream?", "Where do I get the key for my client?", "Where do I see why a request failed?"
- The route page default view starts from exposed models and health, not from internal channels and probability math.

## Downstream Key Site Assignment Redesign

Current problem:

- `群组` means too many different things:
  - route groups/model aliases inside `token_routes`
  - downstream key `groupName`
  - selected group route ids inside downstream key policy
  - OAuth route units/pools
- Downstream keys currently expose low-level controls:
  - model pattern whitelist
  - allowed route ids
  - site weight multipliers as JSON
  - excluded sites
  - excluded credentials
- This is powerful but backwards for the common case. Users want to say: "this client should use these sites automatically, with failover".

New concept names:

- `模型群组`: only for exposed model aliases/route groups.
- `站点池`: a reusable pool of upstream sites/accounts/tokens.
- `客户端策略`: what a downstream API key can use and how it should route.
- `路由通道`: advanced implementation detail inside a model route.

Proposed data model:

- `site_pools`
  - `id`
  - `name`
  - `description`
  - `strategy`: `balanced` | `cost_first` | `stable_first` | `round_robin` | `backup_only`
  - `enabled`
  - `created_at`, `updated_at`
- `site_pool_members`
  - `id`
  - `pool_id`
  - `site_id`
  - `account_id` nullable
  - `token_id` nullable
  - `role`: `primary` | `backup` | `disabled`
  - `weight`
  - `max_concurrency` nullable
  - `daily_budget` nullable
  - `sort_order`
- `downstream_api_keys`
  - add `site_pool_id` nullable
  - add `assignment_mode`: `auto` | `pool` | `custom`
  - keep existing low-level fields for compatibility as `custom` mode.

Assignment modes:

- `auto`
  - Metapi chooses from all healthy eligible sites for the requested model.
  - Good default for personal use.
- `pool`
  - Key is bound to one site pool.
  - Routing can only use members of that pool.
  - Good for isolating clients, projects, or users.
- `custom`
  - Existing advanced policy: explicit model patterns, allowed route ids, site multipliers, excluded credentials.
  - Kept as an advanced escape hatch.

Automatic site assignment flow:

1. User creates a downstream key from `客户端接入`.
2. UI asks for a simple intent:
   - `默认自动分配`
   - `独占一组站点`
   - `只用便宜站点`
   - `只用稳定站点`
   - `高级自定义`
3. Backend creates or selects a site pool:
   - default pool: all active sites
   - cost pool: active sites sorted/weighted by observed or configured cost
   - stable pool: active sites with recent success and no cooldown
   - project pool: user-selected sites
4. The downstream key stores `assignment_mode` and `site_pool_id`.
5. Token router applies the policy before channel selection:
   - reject channels outside the pool
   - apply pool member weights
   - prefer primary members, then backup members
   - explain pool filtering in route decisions.

API contract sketch:

```ts
type DownstreamAssignmentMode = 'auto' | 'pool' | 'custom';

type SitePoolStrategy =
  | 'balanced'
  | 'cost_first'
  | 'stable_first'
  | 'round_robin'
  | 'backup_only';

type ResolvedDownstreamRoutingPolicy = {
  assignmentMode: DownstreamAssignmentMode;
  sitePoolId?: number | null;
  allowedSiteIds?: number[];
  allowedCredentialRefs?: DownstreamCredentialRef[];
  siteWeightMultipliers: Record<number, number>;
  supportedModels: string[];
  allowedRouteIds: number[];
  excludedSiteIds: number[];
  excludedCredentialRefs: DownstreamExcludedCredentialRef[];
};
```

Migration path:

- Existing downstream keys become `assignment_mode = custom`.
- Existing `groupName` becomes display metadata only, not routing semantics.
- Existing `allowedRouteIds` continue to work for model groups.
- New simple keys default to `assignment_mode = auto`.

UI redesign:

- `客户端接入` create key modal:
  - Step 1: name and key.
  - Step 2: choose assignment mode.
  - Step 3: choose model access: all models / selected models / selected model groups.
  - Step 4: show generated base URL and test button.
- `站点池` page or tab:
  - list pools
  - show sites/accounts in each pool
  - health, quota, last failure, check-in status
  - drag sites between primary and backup
- Advanced section:
  - raw model patterns
  - route ids
  - JSON site multipliers
  - credential exclusions

Acceptance criteria:

- Creating a downstream key no longer requires understanding route groups, P0/P1 buckets, or JSON site multipliers.
- A downstream key can be bound to an automatically maintained site pool.
- Route explanation says: "skipped because site is outside this client's site pool" when applicable.
- Existing keys keep their behavior after migration.

## Verification Strategy

- Unit tests:
  - custom check-in parser/executor
  - route explanation reason coverage
  - forced channel permission checks
  - health recovery classification
- Integration tests:
  - `/api/checkin/trigger/:id` with custom flow
  - `/api/routes/decision` with downstream key context
  - proxy forced-channel success and unavailable-channel failure
- Existing guardrails:
  - `npm run typecheck:server`
  - targeted `vitest` files around touched services
  - `npm run repo:drift-check` for architecture-sensitive changes

## First Implementation Slice

Start with Phase 1 because it removes the daily friction before adding more power. Then immediately do Phase 2 so the simplified flow is still diagnosable when routing behaves unexpectedly.

Tasks:

1. Define the quick setup backend orchestration contract and result states.
2. Implement the API around existing site/account/token/model/route services.
3. Build the minimal quick setup UI.
4. Add a smoke proxy test and final downstream connection output.
5. Then add route decision candidate fields for site id, token id, source model, cooldown, and block class.
6. Add a safe forced-channel header for non-tester proxy requests, behind downstream-key permission.
7. Persist route decision summaries into proxy debug traces.
8. Add tests around setup orchestration, forced-channel, and explanation reasons.

Done means a new upstream can be made usable from one screen, and a live request can be forced to a known channel; when it cannot, the response/debug trace explains exactly why.

## Key Risks

- Custom check-in can become an unsafe HTTP scripting feature. Keep it narrowly scoped, no arbitrary JavaScript, and redact secrets in logs.
- Route health already has several layers: channel cooldown, runtime breaker, sticky sessions, downstream policy, and model mapping. New availability logic must extend existing sources of truth instead of creating a parallel health system.
- Schema changes must update Drizzle schema, SQLite migrations, generated schema contracts, and runtime bootstrap artifacts together.
- Force-routing is powerful. It should be opt-in per downstream key or admin-only to avoid users bypassing isolation policy.
