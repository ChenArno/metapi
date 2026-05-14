import { and, asc, eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import {
  isLikelyConversationModel,
  probeRuntimeModel,
  type RuntimeModelProbeStatus,
} from './runtimeModelProbe.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isUsableAccountToken,
} from './accountTokenService.js';

export type RealtimeMonitorCandidateKind = 'account' | 'token';

export type RealtimeMonitorCandidate = {
  id: string;
  kind: RealtimeMonitorCandidateKind;
  modelName: string;
  siteId: number;
  siteName: string;
  platform: string;
  accountId: number;
  username: string | null;
  tokenId: number | null;
  tokenName: string | null;
  lastKnownLatencyMs: number | null;
  lastCheckedAt: string | null;
  costScore: number;
  costLabel: string;
  recommended: boolean;
};

export type RealtimeMonitorProbeResult = {
  candidate: RealtimeMonitorCandidate;
  status: RuntimeModelProbeStatus;
  latencyMs: number | null;
  reason: string;
  checkedAt: string;
};

const LOW_COST_HINTS = [
  { label: 'free', pattern: /(^|[-_/.:])free($|[-_/.:])/i },
  { label: 'mini', pattern: /(^|[-_/.:])mini($|[-_/.:])/i },
  { label: 'nano', pattern: /(^|[-_/.:])nano($|[-_/.:])/i },
  { label: 'flash', pattern: /(^|[-_/.:])flash($|[-_/.:])/i },
  { label: 'lite', pattern: /(^|[-_/.:])lite($|[-_/.:])/i },
  { label: 'haiku', pattern: /(^|[-_/.:])haiku($|[-_/.:])/i },
  { label: 'small', pattern: /(^|[-_/.:])small($|[-_/.:])/i },
  { label: 'cheap', pattern: /(^|[-_/.:])cheap($|[-_/.:])/i },
  { label: 'turbo', pattern: /(^|[-_/.:])turbo($|[-_/.:])/i },
  { label: 'instant', pattern: /(^|[-_/.:])instant($|[-_/.:])/i },
  { label: '8b', pattern: /(^|[-_/.:])8b($|[-_/.:])/i },
  { label: '7b', pattern: /(^|[-_/.:])7b($|[-_/.:])/i },
];

const HIGH_COST_HINTS = [
  { label: 'opus', pattern: /(^|[-_/.:])opus($|[-_/.:])/i },
  { label: 'sonnet', pattern: /(^|[-_/.:])sonnet($|[-_/.:])/i },
  { label: 'pro', pattern: /(^|[-_/.:])pro($|[-_/.:])/i },
  { label: 'max', pattern: /(^|[-_/.:])max($|[-_/.:])/i },
  { label: 'large', pattern: /(^|[-_/.:])large($|[-_/.:])/i },
  { label: 'preview', pattern: /(^|[-_/.:])preview($|[-_/.:])/i },
  { label: 'thinking', pattern: /(^|[-_/.:])thinking($|[-_/.:])/i },
  { label: 'reasoning', pattern: /(^|[-_/.:])reasoning($|[-_/.:])/i },
  { label: 'o1', pattern: /(^|[-_/.:])o1($|[-_/.:])/i },
  { label: 'o3', pattern: /(^|[-_/.:])o3($|[-_/.:])/i },
  { label: 'gpt-4.5', pattern: /(^|[-_/.:])gpt-4\.5($|[-_/.:])/i },
];

function buildCandidateId(kind: RealtimeMonitorCandidateKind, rowId: number): string {
  return `${kind}:${rowId}`;
}

function scoreModelCost(modelName: string): { score: number; label: string } {
  let score = 50;
  const reasons: string[] = [];

  for (const hint of LOW_COST_HINTS) {
    if (hint.pattern.test(modelName)) {
      score -= 10;
      reasons.push(hint.label);
    }
  }
  for (const hint of HIGH_COST_HINTS) {
    if (hint.pattern.test(modelName)) {
      score += 12;
      reasons.push(`避开 ${hint.label}`);
    }
  }
  if (/gpt-5(\.|-|$)/i.test(modelName) && !/mini|nano/i.test(modelName)) {
    score += 12;
    reasons.push('主力模型');
  }
  if (/gemini.*flash/i.test(modelName)) {
    score -= 8;
    reasons.push('flash');
  }

  const clamped = Math.max(1, Math.min(100, score));
  if (clamped <= 40) return { score: clamped, label: reasons.length ? `相对便宜：${Array.from(new Set(reasons)).slice(0, 2).join(' / ')}` : '相对便宜' };
  if (clamped <= 55) return { score: clamped, label: '普通成本' };
  return { score: clamped, label: reasons.length ? `谨慎测试：${Array.from(new Set(reasons)).slice(0, 2).join(' / ')}` : '谨慎测试' };
}

function sortCandidates(a: RealtimeMonitorCandidate, b: RealtimeMonitorCandidate): number {
  if (a.costScore !== b.costScore) return a.costScore - b.costScore;
  if (a.kind !== b.kind) return a.kind === 'token' ? -1 : 1;
  const aLatency = a.lastKnownLatencyMs ?? Number.MAX_SAFE_INTEGER;
  const bLatency = b.lastKnownLatencyMs ?? Number.MAX_SAFE_INTEGER;
  if (aLatency !== bLatency) return aLatency - bLatency;
  return a.modelName.localeCompare(b.modelName);
}

function markRecommended(candidates: RealtimeMonitorCandidate[]): RealtimeMonitorCandidate[] {
  const lowCostCandidates = candidates.filter((candidate) => candidate.costScore <= 40);
  const recommendedSource = lowCostCandidates.length > 0 ? lowCostCandidates : candidates.slice(0, 1);
  const recommendedIds = new Set(recommendedSource.slice(0, 12).map((candidate) => candidate.id));
  return candidates.map((candidate) => ({
    ...candidate,
    recommended: recommendedIds.has(candidate.id),
  }));
}

function hasAccountProbeCredential(account: typeof schema.accounts.$inferSelect): boolean {
  return Boolean(String(account.apiToken || '').trim() || String(account.oauthProvider || '').trim());
}

export async function listRealtimeMonitorCandidates(limit = 80): Promise<RealtimeMonitorCandidate[]> {
  const candidates: RealtimeMonitorCandidate[] = [];

  const tokenRows = await db.select()
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.tokenModelAvailability.available, true),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    ))
    .orderBy(asc(schema.tokenModelAvailability.checkedAt))
    .all();

  for (const row of tokenRows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
    if (!isLikelyConversationModel(row.token_model_availability.modelName)) continue;
    const cost = scoreModelCost(row.token_model_availability.modelName);
    candidates.push({
      id: buildCandidateId('token', row.token_model_availability.id),
      kind: 'token',
      modelName: row.token_model_availability.modelName,
      siteId: row.sites.id,
      siteName: row.sites.name,
      platform: row.sites.platform,
      accountId: row.accounts.id,
      username: row.accounts.username,
      tokenId: row.account_tokens.id,
      tokenName: row.account_tokens.name,
      lastKnownLatencyMs: row.token_model_availability.latencyMs,
      lastCheckedAt: row.token_model_availability.checkedAt,
      costScore: cost.score,
      costLabel: cost.label,
      recommended: false,
    });
  }

  const accountRows = await db.select()
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.modelAvailability.available, true),
      eq(schema.accounts.status, 'active'),
      eq(schema.sites.status, 'active'),
    ))
    .orderBy(asc(schema.modelAvailability.checkedAt))
    .all();

  for (const row of accountRows) {
    if (!hasAccountProbeCredential(row.accounts)) continue;
    if (!isLikelyConversationModel(row.model_availability.modelName)) continue;
    const cost = scoreModelCost(row.model_availability.modelName);
    candidates.push({
      id: buildCandidateId('account', row.model_availability.id),
      kind: 'account',
      modelName: row.model_availability.modelName,
      siteId: row.sites.id,
      siteName: row.sites.name,
      platform: row.sites.platform,
      accountId: row.accounts.id,
      username: row.accounts.username,
      tokenId: null,
      tokenName: null,
      lastKnownLatencyMs: row.model_availability.latencyMs,
      lastCheckedAt: row.model_availability.checkedAt,
      costScore: cost.score,
      costLabel: cost.label,
      recommended: false,
    });
  }

  return markRecommended(candidates.sort(sortCandidates).slice(0, limit));
}

export async function probeRealtimeMonitorCandidate(input: {
  candidateId?: string | null;
  modelName?: string | null;
  siteId?: number | null;
  accountId?: number | null;
  timeoutMs?: number | null;
}): Promise<RealtimeMonitorProbeResult | null> {
  const candidates = await listRealtimeMonitorCandidates(200);
  const candidate = candidates.find((item) => (
    input.candidateId
      ? item.id === input.candidateId
      : (
        (!input.modelName || item.modelName === input.modelName)
        && (!input.siteId || item.siteId === input.siteId)
        && (!input.accountId || item.accountId === input.accountId)
      )
  )) || candidates.find((item) => item.recommended) || candidates[0];

  if (!candidate) return null;

  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, candidate.accountId))
    .get();
  const site = await db.select().from(schema.sites)
    .where(eq(schema.sites.id, candidate.siteId))
    .get();
  if (!account || !site) return null;

  let tokenValue: string | null = null;
  if (candidate.kind === 'token' && candidate.tokenId) {
    const token = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, candidate.tokenId))
      .get();
    if (isUsableAccountToken(token)) {
      tokenValue = token.token;
    }
  }

  const result = await probeRuntimeModel({
    site,
    account,
    modelName: candidate.modelName,
    tokenValue,
    timeoutMs: Math.max(3_000, Math.min(30_000, input.timeoutMs || config.modelAvailabilityProbeTimeoutMs)),
  });

  return {
    candidate,
    status: result.status,
    latencyMs: result.latencyMs,
    reason: result.reason,
    checkedAt: new Date().toISOString(),
  };
}
