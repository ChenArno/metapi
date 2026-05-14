import { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db, hasProxyLogDownstreamApiKeyIdColumn, runtimeDbDialect, schema } from '../../db/index.js';
import { insertAndGetById } from '../../db/insertHelpers.js';
import {
  getDownstreamApiKeyById,
  listDownstreamApiKeys,
  normalizeDownstreamApiKeyPayload,
  toDownstreamApiKeyPolicyView,
  toPersistenceJson,
} from '../../services/downstreamApiKeyService.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import type { DownstreamExcludedCredentialRef } from '../../services/downstreamPolicyTypes.js';
import {
  readDownstreamApiKeyTrendBuckets,
  resolveDownstreamTrendBucketSeconds,
  resolveDownstreamTrendRangeSinceUtc,
  resolveDownstreamTrendTimeZone,
  type DownstreamKeyTrendRange,
} from '../../services/downstreamApiKeyTrendService.js';
import {
  parseDownstreamApiKeyBatchPayload,
  parseDownstreamApiKeyPayload,
} from '../../contracts/downstreamApiKeyRoutePayloads.js';

function parseRouteId(raw: string): number | null {
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function validateKeyShape(key: string): boolean {
  return key.startsWith('sk-') && key.length >= 6;
}

type ErrorLike = {
  message?: string;
  code?: string | number;
  cause?: unknown;
};

function getErrorChain(error: unknown): ErrorLike[] {
  const chain: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current as ErrorLike);
    current = (current as ErrorLike).cause;
  }
  return chain;
}

function looksLikeUniqueViolation(error: unknown): boolean {
  const chain = getErrorChain(error);
  if (runtimeDbDialect === 'postgres') {
    return chain.some((entry) => {
      const message = entry.message || '';
      const code = String(entry.code || '');
      return code === '23505'
        || (message.includes('duplicate key value violates unique constraint')
          && message.includes('downstream_api_keys_key_unique'));
    });
  }
  return chain.some((entry) => {
    const message = entry.message || '';
    const code = String(entry.code || '');
    return code === 'SQLITE_CONSTRAINT'
      || code === 'SQLITE_CONSTRAINT_UNIQUE'
      || (message.includes('UNIQUE constraint failed') && message.includes('downstream_api_keys.key'));
  });
}

function normalizeBatchIds(raw: unknown): number[] {
  const values = Array.isArray(raw) ? raw : [];
  const ids: number[] = [];
  for (const item of values) {
    const parsed = Number(item);
    if (!Number.isFinite(parsed)) continue;
    const id = Math.trunc(parsed);
    if (id <= 0 || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length >= 500) break;
  }
  return ids;
}

type DownstreamKeyRange = DownstreamKeyTrendRange;
type DownstreamKeyStatus = 'all' | 'enabled' | 'disabled';
type SitePoolStrategy = 'balanced' | 'cost_first' | 'stable_first' | 'round_robin' | 'backup_only';

function normalizeDownstreamKeyRange(raw: unknown): DownstreamKeyRange {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === '24h') return '24h';
  if (value === '7d') return '7d';
  if (value === 'all') return 'all';
  return '24h';
}

function normalizeDownstreamKeyStatus(raw: unknown): DownstreamKeyStatus {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'enabled') return 'enabled';
  if (value === 'disabled') return 'disabled';
  return 'all';
}

function normalizeSearchQuery(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  return value.slice(0, 80);
}

function normalizeGroupQuery(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value.slice(0, 64);
}

function normalizeTagQuery(raw: unknown): string[] {
  const value = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join(',') : '';
  return value
    .split(/[\r\n,，]+/g)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.slice(0, 32))
    .filter((item, index, arr) => arr.findIndex((candidate) => candidate.toLowerCase() === item.toLowerCase()) === index)
    .slice(0, 20);
}

function normalizeTagMatchMode(raw: unknown): 'any' | 'all' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'all' ? 'all' : 'any';
}

function normalizeSitePoolStrategy(raw: unknown): SitePoolStrategy {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'cost_first' || value === 'stable_first' || value === 'round_robin' || value === 'backup_only') {
    return value;
  }
  return 'balanced';
}

function normalizeSitePoolMemberRole(raw: unknown): 'primary' | 'backup' | 'disabled' {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'backup' || value === 'disabled') return value;
  return 'primary';
}

function normalizeSitePoolMemberInputs(raw: unknown): Array<{
  siteId: number;
  accountId: number | null;
  tokenId: number | null;
  role: 'primary' | 'backup' | 'disabled';
  weight: number;
  sortOrder: number;
}> {
  const rows = Array.isArray(raw) ? raw : [];
  const members: Array<{
    siteId: number;
    accountId: number | null;
    tokenId: number | null;
    role: 'primary' | 'backup' | 'disabled';
    weight: number;
    sortOrder: number;
  }> = [];
  const seen = new Set<string>();
  for (const [index, item] of rows.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const siteId = Math.trunc(Number(source.siteId));
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    const accountIdRaw = Math.trunc(Number(source.accountId));
    const tokenIdRaw = Math.trunc(Number(source.tokenId));
    const accountId = Number.isFinite(accountIdRaw) && accountIdRaw > 0 ? accountIdRaw : null;
    const tokenId = Number.isFinite(tokenIdRaw) && tokenIdRaw > 0 ? tokenIdRaw : null;
    const key = `${siteId}:${accountId || 0}:${tokenId || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const weight = Number(source.weight);
    const sortOrder = Math.trunc(Number(source.sortOrder));
    members.push({
      siteId,
      accountId,
      tokenId,
      role: normalizeSitePoolMemberRole(source.role),
      weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : index,
    });
    if (members.length >= 500) break;
  }
  return members;
}

async function validateSitePoolMembers(members: ReturnType<typeof normalizeSitePoolMemberInputs>): Promise<string | null> {
  const siteIds = Array.from(new Set(members.map((member) => member.siteId)));
  if (siteIds.length === 0) return null;
  const sites = await db.select({ id: schema.sites.id })
    .from(schema.sites)
    .where(inArray(schema.sites.id, siteIds))
    .all();
  const existingSiteIds = new Set(sites.map((site) => Number(site.id)));
  const missingSiteIds = siteIds.filter((siteId) => !existingSiteIds.has(siteId));
  if (missingSiteIds.length > 0) return `站点池包含不存在的站点: ${missingSiteIds.join(', ')}`;

  const accountIds = Array.from(new Set(
    members
      .map((member) => member.accountId)
      .filter((accountId): accountId is number => typeof accountId === 'number' && accountId > 0),
  ));
  if (accountIds.length > 0) {
    const accounts = await db.select({
      id: schema.accounts.id,
      siteId: schema.accounts.siteId,
    })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, accountIds))
      .all();
    const accountById = new Map(accounts.map((account) => [Number(account.id), Number(account.siteId)]));
    for (const member of members) {
      if (!member.accountId) continue;
      const siteId = accountById.get(member.accountId);
      if (!siteId) return `站点池包含不存在的账号: ${member.accountId}`;
      if (siteId !== member.siteId) return `站点池账号与站点不匹配: ${member.accountId}`;
    }
  }

  const tokenIds = Array.from(new Set(
    members
      .map((member) => member.tokenId)
      .filter((tokenId): tokenId is number => typeof tokenId === 'number' && tokenId > 0),
  ));
  if (tokenIds.length > 0) {
    const tokens = await db.select({
      id: schema.accountTokens.id,
      accountId: schema.accountTokens.accountId,
    })
      .from(schema.accountTokens)
      .where(inArray(schema.accountTokens.id, tokenIds))
      .all();
    const tokenById = new Map(tokens.map((token) => [Number(token.id), Number(token.accountId)]));
    for (const member of members) {
      if (!member.tokenId) continue;
      const accountId = tokenById.get(member.tokenId);
      if (!accountId) return `站点池包含不存在的令牌: ${member.tokenId}`;
      if (member.accountId && accountId !== member.accountId) return `站点池令牌与账号不匹配: ${member.tokenId}`;
    }
  }

  return null;
}

async function listSitePools() {
  const [pools, members] = await Promise.all([
    db.select().from(schema.sitePools).all(),
    db.select({
      id: schema.sitePoolMembers.id,
      poolId: schema.sitePoolMembers.poolId,
      siteId: schema.sitePoolMembers.siteId,
      siteName: schema.sites.name,
      accountId: schema.sitePoolMembers.accountId,
      username: schema.accounts.username,
      tokenId: schema.sitePoolMembers.tokenId,
      tokenName: schema.accountTokens.name,
      role: schema.sitePoolMembers.role,
      weight: schema.sitePoolMembers.weight,
      sortOrder: schema.sitePoolMembers.sortOrder,
    })
      .from(schema.sitePoolMembers)
      .innerJoin(schema.sites, eq(schema.sitePoolMembers.siteId, schema.sites.id))
      .leftJoin(schema.accounts, eq(schema.sitePoolMembers.accountId, schema.accounts.id))
      .leftJoin(schema.accountTokens, eq(schema.sitePoolMembers.tokenId, schema.accountTokens.id))
      .all(),
  ]);
  const membersByPoolId = new Map<number, typeof members>();
  for (const member of members) {
    const poolId = Number(member.poolId);
    if (!membersByPoolId.has(poolId)) membersByPoolId.set(poolId, []);
    membersByPoolId.get(poolId)!.push(member);
  }
  return pools
    .map((pool) => ({
      ...pool,
      members: (membersByPoolId.get(pool.id) || [])
        .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id - right.id),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
}

function resolveRangeSinceUtc(range: DownstreamKeyRange): string | null {
  return resolveDownstreamTrendRangeSinceUtc(range);
}

async function validatePolicyReferences(input: {
  assignmentMode?: string;
  sitePoolId?: number | null;
  allowedRouteIds: number[];
  siteWeightMultipliers: Record<number, number>;
  excludedSiteIds: number[];
  excludedCredentialRefs: DownstreamExcludedCredentialRef[];
}): Promise<string | null> {
  if (input.assignmentMode === 'pool') {
    if (!input.sitePoolId) {
      return 'assignmentMode=pool 时必须选择站点池';
    }
    const pool = await db.select({ id: schema.sitePools.id })
      .from(schema.sitePools)
      .where(eq(schema.sitePools.id, input.sitePoolId))
      .get();
    if (!pool) {
      return `sitePoolId 不存在: ${input.sitePoolId}`;
    }
  }

  const routeIds = input.allowedRouteIds || [];
  if (routeIds.length > 0) {
    const rows = await db.select({ id: schema.tokenRoutes.id })
      .from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, routeIds))
      .all();
    const existingIds = new Set(rows.map((row) => Number(row.id)));
    const missingIds = routeIds.filter((id) => !existingIds.has(id));
    if (missingIds.length > 0) {
      return `allowedRouteIds 包含不存在的路由: ${missingIds.join(', ')}`;
    }
  }

  const weightedSiteIds = Object.keys(input.siteWeightMultipliers || {})
    .map((key) => Number(key))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
  const excludedSiteIds = (input.excludedSiteIds || [])
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.trunc(value));
  const siteIds = Array.from(new Set([...weightedSiteIds, ...excludedSiteIds]));
  if (siteIds.length > 0) {
    const rows = await db.select({ id: schema.sites.id })
      .from(schema.sites)
      .where(inArray(schema.sites.id, siteIds))
      .all();
    const existingIds = new Set(rows.map((row) => Number(row.id)));
    const missingIds = siteIds.filter((id) => !existingIds.has(id));
    if (missingIds.length > 0) {
      return `策略中包含不存在的站点: ${missingIds.join(', ')}`;
    }
  }

  const credentialRefs = input.excludedCredentialRefs || [];
  const accountTokenRefs = credentialRefs.filter((ref): ref is Extract<DownstreamExcludedCredentialRef, { kind: 'account_token' }> => ref.kind === 'account_token');
  if (accountTokenRefs.length > 0) {
    const tokenIds = Array.from(new Set(accountTokenRefs.map((ref) => ref.tokenId)));
    const rows = await db.select({
      tokenId: schema.accountTokens.id,
      accountId: schema.accounts.id,
      siteId: schema.accounts.siteId,
    })
      .from(schema.accountTokens)
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .where(inArray(schema.accountTokens.id, tokenIds))
      .all();
    const tokenById = new Map<number, { tokenId: number; accountId: number; siteId: number }>(
      rows.map((row) => [Number(row.tokenId), {
        tokenId: Number(row.tokenId),
        accountId: Number(row.accountId),
        siteId: Number(row.siteId),
      }]),
    );
    for (const ref of accountTokenRefs) {
      const matched = tokenById.get(ref.tokenId);
      if (!matched) {
        return `excludedCredentialRefs 包含不存在的令牌: ${ref.tokenId}`;
      }
      if (Number(matched.accountId) !== ref.accountId || Number(matched.siteId) !== ref.siteId) {
        return `excludedCredentialRefs 中的 account_token 引用与账号/站点不匹配: ${ref.tokenId}`;
      }
    }
  }

  const defaultApiKeyRefs = credentialRefs.filter((ref): ref is Extract<DownstreamExcludedCredentialRef, { kind: 'default_api_key' }> => ref.kind === 'default_api_key');
  if (defaultApiKeyRefs.length > 0) {
    const accountIds = Array.from(new Set(defaultApiKeyRefs.map((ref) => ref.accountId)));
    const rows = await db.select({
      accountId: schema.accounts.id,
      siteId: schema.accounts.siteId,
      apiToken: schema.accounts.apiToken,
    })
      .from(schema.accounts)
      .where(inArray(schema.accounts.id, accountIds))
      .all();
    const accountById = new Map<number, { accountId: number; siteId: number; apiToken: string | null }>(
      rows.map((row) => [Number(row.accountId), {
        accountId: Number(row.accountId),
        siteId: Number(row.siteId),
        apiToken: row.apiToken,
      }]),
    );
    for (const ref of defaultApiKeyRefs) {
      const matched = accountById.get(ref.accountId);
      if (!matched) {
        return `excludedCredentialRefs 包含不存在的账号: ${ref.accountId}`;
      }
      if (Number(matched.siteId) !== ref.siteId) {
        return `excludedCredentialRefs 中的 default_api_key 引用与站点不匹配: ${ref.accountId}`;
      }
      if (!(matched.apiToken || '').trim()) {
        return `excludedCredentialRefs 中的 default_api_key 账号缺少默认 API Key: ${ref.accountId}`;
      }
    }
  }

  return null;
}

export async function downstreamApiKeysRoutes(app: FastifyInstance) {
  app.get('/api/site-pools', async () => ({
    success: true,
    items: await listSitePools(),
  }));

  app.post<{ Body: any }>('/api/site-pools', async (request, reply) => {
    const body = (request.body || {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return reply.code(400).send({ success: false, message: 'name 不能为空' });
    const members = normalizeSitePoolMemberInputs(body.members);
    const memberError = await validateSitePoolMembers(members);
    if (memberError) return reply.code(400).send({ success: false, message: memberError });

    const nowIso = formatUtcSqlDateTime(new Date());
    const inserted = await insertAndGetById<typeof schema.sitePools.$inferSelect>({
      table: schema.sitePools,
      idColumn: schema.sitePools.id,
      values: {
        name,
        description: typeof body.description === 'string' ? body.description.trim() || null : null,
        strategy: normalizeSitePoolStrategy(body.strategy),
        enabled: body.enabled === undefined ? true : !!body.enabled,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      insertErrorMessage: '创建站点池失败',
      loadErrorMessage: '创建站点池失败',
    });

    if (members.length > 0) {
      await db.insert(schema.sitePoolMembers).values(members.map((member) => ({
        poolId: inserted.id,
        siteId: member.siteId,
        accountId: member.accountId,
        tokenId: member.tokenId,
        role: member.role,
        weight: member.weight,
        sortOrder: member.sortOrder,
        createdAt: nowIso,
        updatedAt: nowIso,
      }))).run();
    }

    return { success: true, item: (await listSitePools()).find((pool) => pool.id === inserted.id) || inserted };
  });

  app.put<{ Params: { id: string }; Body: any }>('/api/site-pools/:id', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: 'id 无效' });
    const existing = await db.select().from(schema.sitePools).where(eq(schema.sitePools.id, id)).get();
    if (!existing) return reply.code(404).send({ success: false, message: '站点池不存在' });

    const body = (request.body || {}) as Record<string, unknown>;
    const name = Object.prototype.hasOwnProperty.call(body, 'name')
      ? (typeof body.name === 'string' ? body.name.trim() : '')
      : existing.name;
    if (!name) return reply.code(400).send({ success: false, message: 'name 不能为空' });
    const membersProvided = Object.prototype.hasOwnProperty.call(body, 'members');
    const members = membersProvided ? normalizeSitePoolMemberInputs(body.members) : [];
    if (membersProvided) {
      const memberError = await validateSitePoolMembers(members);
      if (memberError) return reply.code(400).send({ success: false, message: memberError });
    }

    const nowIso = formatUtcSqlDateTime(new Date());
    await db.update(schema.sitePools).set({
      name,
      description: Object.prototype.hasOwnProperty.call(body, 'description')
        ? (typeof body.description === 'string' ? body.description.trim() || null : null)
        : existing.description,
      strategy: Object.prototype.hasOwnProperty.call(body, 'strategy')
        ? normalizeSitePoolStrategy(body.strategy)
        : existing.strategy,
      enabled: Object.prototype.hasOwnProperty.call(body, 'enabled') ? !!body.enabled : existing.enabled,
      updatedAt: nowIso,
    }).where(eq(schema.sitePools.id, id)).run();

    if (membersProvided) {
      await db.delete(schema.sitePoolMembers).where(eq(schema.sitePoolMembers.poolId, id)).run();
      if (members.length > 0) {
        await db.insert(schema.sitePoolMembers).values(members.map((member) => ({
          poolId: id,
          siteId: member.siteId,
          accountId: member.accountId,
          tokenId: member.tokenId,
          role: member.role,
          weight: member.weight,
          sortOrder: member.sortOrder,
          createdAt: nowIso,
          updatedAt: nowIso,
        }))).run();
      }
    }

    return { success: true, item: (await listSitePools()).find((pool) => pool.id === id) || null };
  });

  app.delete<{ Params: { id: string } }>('/api/site-pools/:id', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: 'id 无效' });
    await db.delete(schema.sitePools).where(eq(schema.sitePools.id, id)).run();
    return { success: true };
  });

  app.get<{ Querystring: { range?: string; status?: string; search?: string; group?: string; tags?: string | string[]; tagMatch?: string } }>('/api/downstream-keys/summary', async (request) => {
    const range = normalizeDownstreamKeyRange(request.query?.range);
    const status = normalizeDownstreamKeyStatus(request.query?.status);
    const search = normalizeSearchQuery(request.query?.search);
    const group = normalizeGroupQuery(request.query?.group);
    const tags = normalizeTagQuery(request.query?.tags);
    const tagMatch = normalizeTagMatchMode(request.query?.tagMatch);

    const whereClauses: SQL[] = [];
    if (status === 'enabled') {
      whereClauses.push(eq(schema.downstreamApiKeys.enabled, true));
    } else if (status === 'disabled') {
      whereClauses.push(eq(schema.downstreamApiKeys.enabled, false));
    }
    if (search) {
      const pattern = `%${search.toLowerCase()}%`;
      whereClauses.push(sql`(lower(${schema.downstreamApiKeys.name}) like ${pattern} or lower(coalesce(${schema.downstreamApiKeys.description}, '')) like ${pattern})`);
    }

    let keysQuery = db.select().from(schema.downstreamApiKeys);
    if (whereClauses.length > 0) {
      keysQuery = keysQuery.where(and(...whereClauses));
    }
    const keys = (await keysQuery.all())
      .map((row) => toDownstreamApiKeyPolicyView(row))
      .filter((item) => {
        if (group === '__ungrouped__') {
          if (item.groupName) return false;
        } else if (group && item.groupName !== group) {
          return false;
        }

        if (!search && tags.length === 0) return true;
        const haystack = [
          item.name,
          item.description || '',
          item.keyMasked,
          item.groupName || '',
          ...item.tags,
          ...item.supportedModels,
        ].join(' ').toLowerCase();
        if (search && !haystack.includes(search.toLowerCase())) return false;
        if (tags.length === 0) return true;
        const itemTags = new Set(item.tags.map((tag) => tag.toLowerCase()));
        return tagMatch === 'all'
          ? tags.every((tag) => itemTags.has(tag.toLowerCase()))
          : tags.some((tag) => itemTags.has(tag.toLowerCase()));
      })
      .sort((a, b) => b.id - a.id);

    if (keys.length === 0) {
      return { success: true, range, status, search, group, tags, tagMatch, items: [] };
    }

    const columnReady = await hasProxyLogDownstreamApiKeyIdColumn();
    const sinceUtc = resolveRangeSinceUtc(range);
    const ids = keys.map((k) => k.id);

    const usageRows = columnReady
      ? await db.select({
        keyId: schema.proxyLogs.downstreamApiKeyId,
        totalRequests: sql<number>`count(*)`,
        successRequests: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
        failedRequests: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 0 else 1 end), 0)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
        totalCost: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.estimatedCost}, 0)), 0)`,
      })
        .from(schema.proxyLogs)
        .where(and(
          inArray(schema.proxyLogs.downstreamApiKeyId, ids),
          ...(sinceUtc ? [sql`${schema.proxyLogs.createdAt} >= ${sinceUtc}`] : []),
        ))
        .groupBy(schema.proxyLogs.downstreamApiKeyId)
        .all()
      : [];

    const usageByKey = new Map<number, {
      totalRequests: number;
      successRequests: number;
      failedRequests: number;
      totalTokens: number;
      totalCost: number;
    }>();

    for (const row of usageRows) {
      const keyId = Number((row as any).keyId ?? 0);
      if (!Number.isFinite(keyId) || keyId <= 0) continue;
      usageByKey.set(keyId, {
        totalRequests: Number((row as any).totalRequests || 0),
        successRequests: Number((row as any).successRequests || 0),
        failedRequests: Number((row as any).failedRequests || 0),
        totalTokens: Number((row as any).totalTokens || 0),
        totalCost: Number((row as any).totalCost || 0),
      });
    }

    return {
      success: true,
      range,
      status,
      search,
      group,
      tags,
      tagMatch,
      items: keys.map((key) => {
        const usage = usageByKey.get(key.id) || {
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          totalTokens: 0,
          totalCost: 0,
        };
        const successRate = usage.totalRequests > 0
          ? Math.round((usage.successRequests / usage.totalRequests) * 1000) / 10
          : null;
        return {
          ...key,
          rangeUsage: {
            totalRequests: usage.totalRequests,
            successRequests: usage.successRequests,
            failedRequests: usage.failedRequests,
            successRate,
            totalTokens: usage.totalTokens,
            totalCost: Math.round(usage.totalCost * 1_000_000) / 1_000_000,
          },
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/api/downstream-keys/:id/overview', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: 'id 无效' });
    }

    const item = await getDownstreamApiKeyById(id);
    if (!item) {
      return reply.code(404).send({ success: false, message: 'API key 不存在' });
    }

    const columnReady = await hasProxyLogDownstreamApiKeyIdColumn();
    if (!columnReady) {
      return { success: true, item, usage: { last24h: null, last7d: null, all: null } };
    }

    const readAggregate = async (range: DownstreamKeyRange) => {
      const sinceUtc = resolveRangeSinceUtc(range);
      const row = await db.select({
        totalRequests: sql<number>`count(*)`,
        successRequests: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
        failedRequests: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 0 else 1 end), 0)`,
        totalTokens: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
        totalCost: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.estimatedCost}, 0)), 0)`,
      })
        .from(schema.proxyLogs)
        .where(and(
          eq(schema.proxyLogs.downstreamApiKeyId, id),
          ...(sinceUtc ? [sql`${schema.proxyLogs.createdAt} >= ${sinceUtc}`] : []),
        ))
        .get();

      const totalRequests = Number((row as any)?.totalRequests || 0);
      const successRequests = Number((row as any)?.successRequests || 0);
      const totalCost = Number((row as any)?.totalCost || 0);
      return {
        totalRequests,
        successRequests,
        failedRequests: Number((row as any)?.failedRequests || 0),
        successRate: totalRequests > 0 ? Math.round((successRequests / totalRequests) * 1000) / 10 : null,
        totalTokens: Number((row as any)?.totalTokens || 0),
        totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
      };
    };

    const [last24h, last7d, all] = await Promise.all([
      readAggregate('24h'),
      readAggregate('7d'),
      readAggregate('all'),
    ]);

    return { success: true, item, usage: { last24h, last7d, all } };
  });

  app.get<{ Params: { id: string }; Querystring: { range?: string; timeZone?: string } }>('/api/downstream-keys/:id/trend', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: 'id 无效' });
    }

    const range = normalizeDownstreamKeyRange(request.query?.range);
    const item = await getDownstreamApiKeyById(id);
    if (!item) {
      return reply.code(404).send({ success: false, message: 'API key 不存在' });
    }

    const columnReady = await hasProxyLogDownstreamApiKeyIdColumn();
    if (!columnReady) {
      return {
        success: true,
        range,
        item: { id: item.id, name: item.name },
        bucketSeconds: resolveDownstreamTrendBucketSeconds(range),
        timeZone: resolveDownstreamTrendTimeZone(request.query?.timeZone),
        buckets: [],
      };
    }

    const trend = await readDownstreamApiKeyTrendBuckets({
      downstreamApiKeyId: id,
      range,
      timeZone: request.query?.timeZone,
    });

    return {
      success: true,
      range,
      item: { id: item.id, name: item.name },
      bucketSeconds: trend.bucketSeconds,
      timeZone: trend.timeZone,
      buckets: trend.buckets,
    };
  });

  app.get('/api/downstream-keys', async () => {
    return {
      success: true,
      items: await listDownstreamApiKeys(),
    };
  });

  app.post<{ Body: unknown }>('/api/downstream-keys', async (request, reply) => {
    const parsedBody = parseDownstreamApiKeyPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const body = parsedBody.data;
    let normalized: ReturnType<typeof normalizeDownstreamApiKeyPayload>;
    try {
      normalized = normalizeDownstreamApiKeyPayload(body);
    } catch (error: unknown) {
      return reply.code(400).send({ success: false, message: (error as Error)?.message || '参数无效' });
    }

    if (!normalized.name) {
      return reply.code(400).send({ success: false, message: 'name 不能为空' });
    }
    if (!normalized.key) {
      return reply.code(400).send({ success: false, message: 'key 不能为空' });
    }
    if (!validateKeyShape(normalized.key)) {
      return reply.code(400).send({ success: false, message: 'key 必须以 sk- 开头且长度至少 6' });
    }
    const policyRefError = await validatePolicyReferences({
      assignmentMode: normalized.assignmentMode,
      sitePoolId: normalized.sitePoolId,
      allowedRouteIds: normalized.allowedRouteIds,
      siteWeightMultipliers: normalized.siteWeightMultipliers,
      excludedSiteIds: normalized.excludedSiteIds,
      excludedCredentialRefs: normalized.excludedCredentialRefs,
    });
    if (policyRefError) {
      return reply.code(400).send({ success: false, message: policyRefError });
    }

    const nowIso = new Date().toISOString();

    try {
      const inserted = await insertAndGetById<typeof schema.downstreamApiKeys.$inferSelect>({
        table: schema.downstreamApiKeys,
        idColumn: schema.downstreamApiKeys.id,
        values: {
          name: normalized.name,
          key: normalized.key,
          description: normalized.description,
          groupName: normalized.groupName,
          tags: toPersistenceJson(normalized.tags),
          assignmentMode: normalized.assignmentMode,
          sitePoolId: normalized.sitePoolId,
          enabled: normalized.enabled,
          expiresAt: normalized.expiresAt,
          maxCost: normalized.maxCost,
          usedCost: 0,
          maxRequests: normalized.maxRequests,
          usedRequests: 0,
          supportedModels: toPersistenceJson(normalized.supportedModels),
          allowedRouteIds: toPersistenceJson(normalized.allowedRouteIds),
          siteWeightMultipliers: toPersistenceJson(normalized.siteWeightMultipliers),
          excludedSiteIds: toPersistenceJson(normalized.excludedSiteIds),
          excludedCredentialRefs: toPersistenceJson(normalized.excludedCredentialRefs),
          createdAt: nowIso,
          updatedAt: nowIso,
        },
        insertErrorMessage: '创建失败',
        loadErrorMessage: '创建失败',
      });

      return {
        success: true,
        item: toDownstreamApiKeyPolicyView(inserted),
      };
    } catch (error: unknown) {
      if (looksLikeUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'API key 已存在' });
      }
      return reply.code(500).send({ success: false, message: (error as Error)?.message || '创建失败' });
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/downstream-keys/:id', async (request, reply) => {
    const parsedBody = parseDownstreamApiKeyPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: 'id 无效' });
    }

    const existing = await db.select().from(schema.downstreamApiKeys)
      .where(eq(schema.downstreamApiKeys.id, id))
      .get();

    if (!existing) {
      return reply.code(404).send({ success: false, message: 'API key 不存在' });
    }

    const existingView = toDownstreamApiKeyPolicyView(existing);
    const body = parsedBody.data;
    const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
    let normalized: ReturnType<typeof normalizeDownstreamApiKeyPayload>;
    try {
      normalized = normalizeDownstreamApiKeyPayload({
        name: hasOwn('name') ? body.name : existing.name,
        key: hasOwn('key') ? body.key : existing.key,
        description: hasOwn('description') ? body.description : existing.description,
        groupName: hasOwn('groupName') ? body.groupName : existing.groupName,
        tags: hasOwn('tags') ? body.tags : existingView.tags,
        assignmentMode: hasOwn('assignmentMode') ? body.assignmentMode : existingView.assignmentMode,
        sitePoolId: hasOwn('sitePoolId') ? body.sitePoolId : existingView.sitePoolId,
        enabled: hasOwn('enabled') ? body.enabled : existing.enabled,
        expiresAt: hasOwn('expiresAt') ? body.expiresAt : existing.expiresAt,
        maxCost: hasOwn('maxCost') ? body.maxCost : existing.maxCost,
        maxRequests: hasOwn('maxRequests') ? body.maxRequests : existing.maxRequests,
        supportedModels: hasOwn('supportedModels') ? body.supportedModels : existingView.supportedModels,
        allowedRouteIds: hasOwn('allowedRouteIds') ? body.allowedRouteIds : existingView.allowedRouteIds,
        siteWeightMultipliers: hasOwn('siteWeightMultipliers') ? body.siteWeightMultipliers : existingView.siteWeightMultipliers,
        excludedSiteIds: hasOwn('excludedSiteIds') ? body.excludedSiteIds : existingView.excludedSiteIds,
        excludedCredentialRefs: hasOwn('excludedCredentialRefs') ? body.excludedCredentialRefs : existingView.excludedCredentialRefs,
      });
    } catch (error: unknown) {
      return reply.code(400).send({ success: false, message: (error as Error)?.message || '参数无效' });
    }

    if (!normalized.name) {
      return reply.code(400).send({ success: false, message: 'name 不能为空' });
    }
    if (!normalized.key) {
      return reply.code(400).send({ success: false, message: 'key 不能为空' });
    }
    if (!validateKeyShape(normalized.key)) {
      return reply.code(400).send({ success: false, message: 'key 必须以 sk- 开头且长度至少 6' });
    }
    const policyRefError = await validatePolicyReferences({
      assignmentMode: normalized.assignmentMode,
      sitePoolId: normalized.sitePoolId,
      allowedRouteIds: normalized.allowedRouteIds,
      siteWeightMultipliers: normalized.siteWeightMultipliers,
      excludedSiteIds: normalized.excludedSiteIds,
      excludedCredentialRefs: normalized.excludedCredentialRefs,
    });
    if (policyRefError) {
      return reply.code(400).send({ success: false, message: policyRefError });
    }

    const nowIso = new Date().toISOString();
    try {
      await db.update(schema.downstreamApiKeys).set({
        name: normalized.name,
        key: normalized.key,
        description: normalized.description,
        groupName: normalized.groupName,
        tags: toPersistenceJson(normalized.tags),
        assignmentMode: normalized.assignmentMode,
        sitePoolId: normalized.sitePoolId,
        enabled: normalized.enabled,
        expiresAt: normalized.expiresAt,
        maxCost: normalized.maxCost,
        maxRequests: normalized.maxRequests,
        supportedModels: toPersistenceJson(normalized.supportedModels),
        allowedRouteIds: toPersistenceJson(normalized.allowedRouteIds),
        siteWeightMultipliers: toPersistenceJson(normalized.siteWeightMultipliers),
        excludedSiteIds: toPersistenceJson(normalized.excludedSiteIds),
        excludedCredentialRefs: toPersistenceJson(normalized.excludedCredentialRefs),
        updatedAt: nowIso,
      }).where(eq(schema.downstreamApiKeys.id, id)).run();

      const updated = await getDownstreamApiKeyById(id);
      return {
        success: true,
        item: updated,
      };
    } catch (error: unknown) {
      if (looksLikeUniqueViolation(error)) {
        return reply.code(409).send({ success: false, message: 'API key 已存在' });
      }
      return reply.code(500).send({ success: false, message: (error as Error)?.message || '更新失败' });
    }
  });

  app.post<{ Params: { id: string } }>('/api/downstream-keys/:id/reset-usage', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: 'id 无效' });
    }

    const existing = await getDownstreamApiKeyById(id);
    if (!existing) {
      return reply.code(404).send({ success: false, message: 'API key 不存在' });
    }

    await db.update(schema.downstreamApiKeys).set({
      usedCost: 0,
      usedRequests: 0,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.downstreamApiKeys.id, id)).run();

    return {
      success: true,
      item: await getDownstreamApiKeyById(id),
    };
  });

  app.delete<{ Params: { id: string } }>('/api/downstream-keys/:id', async (request, reply) => {
    const id = parseRouteId(request.params.id);
    if (!id) {
      return reply.code(400).send({ success: false, message: 'id 无效' });
    }

    const existing = await getDownstreamApiKeyById(id);
    if (!existing) {
      return reply.code(404).send({ success: false, message: 'API key 不存在' });
    }

    await db.delete(schema.downstreamApiKeys)
      .where(eq(schema.downstreamApiKeys.id, id))
      .run();

    return { success: true };
  });

  app.post<{ Body: unknown }>('/api/downstream-keys/batch', async (request, reply) => {
    const parsedBody = parseDownstreamApiKeyBatchPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const body = parsedBody.data;
    const ids = normalizeBatchIds(body.ids);
    const action = String(body.action || '').trim();
    if (ids.length === 0) {
      return reply.code(400).send({ success: false, message: 'ids is required' });
    }
    if (!['enable', 'disable', 'delete', 'resetUsage', 'updateMetadata'].includes(action)) {
      return reply.code(400).send({ success: false, message: 'Invalid action' });
    }

    const groupOperation = String(body.groupOperation || 'keep').trim();
    const tagOperation = String(body.tagOperation || 'keep').trim();
    const normalizedGroupName = normalizeDownstreamApiKeyPayload({ groupName: body.groupName }).groupName;
    const normalizedTags = normalizeDownstreamApiKeyPayload({ tags: body.tags }).tags;

    if (action === 'updateMetadata') {
      if (!['keep', 'set', 'clear'].includes(groupOperation)) {
        return reply.code(400).send({ success: false, message: 'Invalid groupOperation' });
      }
      if (!['keep', 'append'].includes(tagOperation)) {
        return reply.code(400).send({ success: false, message: 'Invalid tagOperation' });
      }
      if (groupOperation === 'set' && !normalizedGroupName) {
        return reply.code(400).send({ success: false, message: 'groupName is required when groupOperation=set' });
      }
      if (tagOperation === 'append' && normalizedTags.length === 0) {
        return reply.code(400).send({ success: false, message: 'tags is required when tagOperation=append' });
      }
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];

    for (const id of ids) {
      try {
        const existing = await getDownstreamApiKeyById(id);
        if (!existing) {
          failedItems.push({ id, message: 'API key 不存在' });
          continue;
        }

        if (action === 'delete') {
          await db.delete(schema.downstreamApiKeys)
            .where(eq(schema.downstreamApiKeys.id, id))
            .run();
        } else if (action === 'resetUsage') {
          await db.update(schema.downstreamApiKeys).set({
            usedCost: 0,
            usedRequests: 0,
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.downstreamApiKeys.id, id)).run();
        } else if (action === 'updateMetadata') {
          const nextGroupName = groupOperation === 'keep'
            ? existing.groupName
            : (groupOperation === 'clear' ? null : normalizedGroupName);
          const nextTags = tagOperation === 'append'
            ? Array.from(new Map([...existing.tags, ...normalizedTags].map((tag) => [tag.toLowerCase(), tag])).values())
            : existing.tags;
          await db.update(schema.downstreamApiKeys).set({
            groupName: nextGroupName,
            tags: toPersistenceJson(nextTags),
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.downstreamApiKeys.id, id)).run();
        } else {
          await db.update(schema.downstreamApiKeys).set({
            enabled: action === 'enable',
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.downstreamApiKeys.id, id)).run();
        }

        successIds.push(id);
      } catch (error: any) {
        failedItems.push({ id, message: error?.message || 'Batch operation failed' });
      }
    }

    return {
      success: true,
      successIds,
      failedItems,
    };
  });
}
