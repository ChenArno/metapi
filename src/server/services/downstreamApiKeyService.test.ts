import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./downstreamApiKeyService.js');
type ConfigModule = typeof import('../config.js');

describe('downstreamApiKeyService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let config: ConfigModule['config'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-downstream-key-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    const serviceModule = await import('./downstreamApiKeyService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    service = serviceModule;
  });

  beforeEach(async () => {
    await db.delete(schema.downstreamApiKeys).run();
    await db.delete(schema.sitePoolMembers).run();
    await db.delete(schema.sitePools).run();
    await db.delete(schema.tokenRoutes).run();
    config.proxyToken = 'sk-global-proxy-token';
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('authorizes global proxy token when no managed key matches', async () => {
    const result = await service.authorizeDownstreamToken('sk-global-proxy-token');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key).toBeNull();
      expect(result.policy.allowedRouteIds).toEqual([]);
      expect(result.policy.supportedModels).toEqual([]);
    }
  });

  it('rejects managed keys by lifecycle guards (disabled, expired, over budget, over requests)', async () => {
    const now = Date.now();

    const disabled = await db.insert(schema.downstreamApiKeys).values({
      name: 'disabled',
      key: 'sk-disabled',
      enabled: false,
    }).returning().get();

    const expired = await db.insert(schema.downstreamApiKeys).values({
      name: 'expired',
      key: 'sk-expired',
      enabled: true,
      expiresAt: new Date(now - 60_000).toISOString(),
    }).returning().get();

    const overBudget = await db.insert(schema.downstreamApiKeys).values({
      name: 'over-budget',
      key: 'sk-over-budget',
      enabled: true,
      maxCost: 1,
      usedCost: 1.2,
    }).returning().get();

    const overRequests = await db.insert(schema.downstreamApiKeys).values({
      name: 'over-requests',
      key: 'sk-over-requests',
      enabled: true,
      maxRequests: 10,
      usedRequests: 10,
    }).returning().get();

    const r1 = await service.authorizeDownstreamToken(disabled.key);
    const r2 = await service.authorizeDownstreamToken(expired.key);
    const r3 = await service.authorizeDownstreamToken(overBudget.key);
    const r4 = await service.authorizeDownstreamToken(overRequests.key);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);
    expect(r4.ok).toBe(false);
  });

  it('ignores legacy model whitelists and keeps route-based policy fields', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'project-a',
      key: 'sk-project-a',
      enabled: true,
      supportedModels: JSON.stringify(['re:^claude-(opus|sonnet)-4-6$', 'gpt-4o-mini']),
      allowedRouteIds: JSON.stringify([101, 102]),
      siteWeightMultipliers: JSON.stringify({ '1': 2.5, '7': 0.4 }),
    }).returning().get();

    const result = await service.authorizeDownstreamToken(row.key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.key?.id).toBe(row.id);
    expect(result.policy.supportedModels).toEqual([]);
    expect(result.policy.allowedRouteIds).toEqual([101, 102]);
    expect(result.policy.siteWeightMultipliers[1]).toBeCloseTo(2.5);
    expect(result.policy.siteWeightMultipliers[7]).toBeCloseTo(0.4);

    expect(service.isModelAllowedByPolicy('claude-opus-4-6', result.policy)).toBe(true);
    expect(service.isModelAllowedByPolicy('gpt-4o-mini', result.policy)).toBe(true);
    expect(service.isModelAllowedByPolicy('gemini-2.0-flash', result.policy)).toBe(true);
  });

  it('resolves pool assignment into allowed site ids during authorization', async () => {
    const siteAllowed = await db.insert(schema.sites).values({
      name: 'allowed-site',
      url: 'https://allowed.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.sites).values({
      name: 'other-site',
      url: 'https://other.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const pool = await db.insert(schema.sitePools).values({
      name: 'client-pool',
      strategy: 'balanced',
      enabled: true,
    }).returning().get();
    await db.insert(schema.sitePoolMembers).values({
      poolId: pool.id,
      siteId: siteAllowed.id,
      role: 'primary',
      weight: 1,
    }).run();
    const key = await db.insert(schema.downstreamApiKeys).values({
      name: 'pool-key',
      key: 'sk-pool-key',
      enabled: true,
      assignmentMode: 'pool',
      sitePoolId: pool.id,
    }).returning().get();

    const result = await service.authorizeDownstreamToken(key.key);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.assignmentMode).toBe('pool');
    expect(result.policy.sitePoolId).toBe(pool.id);
    expect(result.policy.allowedSiteIds).toEqual([siteAllowed.id]);
  });

  it('keeps all explicitly selected supported models when list exceeds 200 items', () => {
    const selectedModels = Array.from({ length: 260 }, (_, index) => `model-${String(index + 1).padStart(3, '0')}`);

    expect(service.normalizeSupportedModelsInput(selectedModels)).toEqual(selectedModels);
  });

  it('uses selected groups as the model authorization scope', async () => {
    const claudeGroup = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-6$',
      displayName: 'claude-4-6-group',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: ['gpt-4o-mini'],
      allowedRouteIds: [claudeGroup.id],
      siteWeightMultipliers: {},
    };

    expect(service.isModelAllowedByPolicy('claude-4-6-group', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-4-6-group', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gpt-4o-mini', policy)).toBe(false);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gemini-2.0-flash', policy)).toBe(false);
  });

  it('denies all models when both supportedModels and allowedRouteIds are empty', async () => {
    const policy = {
      supportedModels: [],
      allowedRouteIds: [],
      siteWeightMultipliers: {},
      denyAllWhenEmpty: true,
    };

    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gpt-4o-mini', policy)).toBe(false);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(false);
  });

  it('authorizes by selected group model pattern only, not arbitrary internal models', async () => {
    const virtualModelGroup = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: [],
      allowedRouteIds: [virtualModelGroup.id],
      siteWeightMultipliers: {},
    };

    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-sonnet-4-6', policy)).toBe(false);
  });

  it('authorizes both selected route display name alias and models covered by the group pattern', async () => {
    const aliasRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 're:^claude-(opus|sonnet)-4-5$',
      displayName: 'claude-opus-4-6',
      enabled: true,
    }).returning().get();

    const policy = {
      supportedModels: [],
      allowedRouteIds: [aliasRoute.id],
      siteWeightMultipliers: {},
    };

    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-6', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-sonnet-4-5', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('claude-opus-4-5', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gpt-4o-mini', policy)).toBe(false);
  });

  it('authorizes direct internal model names for explicit group routes', async () => {
    const sourceRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.4',
      enabled: true,
    }).returning().get();

    const explicitGroup = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5-family',
      displayName: '发发发',
      routeMode: 'explicit_group',
      enabled: true,
    }).returning().get();

    await db.insert(schema.routeGroupSources).values({
      groupRouteId: explicitGroup.id,
      sourceRouteId: sourceRoute.id,
    }).run();

    const policy = {
      supportedModels: [],
      allowedRouteIds: [explicitGroup.id],
      siteWeightMultipliers: {},
    };

    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('发发发', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gpt-5.4', policy)).toBe(true);
    expect(await service.isModelAllowedByPolicyOrAllowedRoutes('gpt-5.4-mini', policy)).toBe(false);
  });

  it('accumulates managed key request/cost usage and applies limits', async () => {
    const row = await db.insert(schema.downstreamApiKeys).values({
      name: 'metered-key',
      key: 'sk-metered-key',
      enabled: true,
      maxRequests: 2,
      maxCost: 1,
      usedRequests: 0,
      usedCost: 0,
    }).returning().get();

    await service.consumeManagedKeyRequest(row.id);
    await service.consumeManagedKeyRequest(row.id);
    await service.recordManagedKeyCostUsage(row.id, 0.4);
    await service.recordManagedKeyCostUsage(row.id, 0.6);

    const latest = await service.getDownstreamApiKeyById(row.id);
    expect(latest?.usedRequests).toBe(2);
    expect(latest?.usedCost).toBeCloseTo(1);

    const authResult = await service.authorizeDownstreamToken(row.key);
    expect(authResult.ok).toBe(false);
  });
});
