import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';

type MonitorCandidate = {
  id: string;
  kind: 'account' | 'token';
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

type ProbeStatus = 'supported' | 'unsupported' | 'inconclusive' | 'skipped';

type ProbeResult = {
  candidate: MonitorCandidate;
  status: ProbeStatus;
  latencyMs: number | null;
  reason: string;
  checkedAt: string;
};

type MonitorModelsResponse = {
  candidates?: MonitorCandidate[];
  recommended?: MonitorCandidate[];
  summary?: {
    total: number;
    recommended: number;
  };
};

type SiteMonitorGroup = {
  key: string;
  siteId: number;
  siteName: string;
  platform: string;
  candidates: MonitorCandidate[];
  recommendedCount: number;
  testedCount: number;
  supportedCount: number;
  failedCount: number;
  avgLatencyMs: number | null;
  lastCheckedAt: string | null;
  status: ProbeStatus | 'untested';
  issue: MonitorIssue;
};

type MonitorIssueKind =
  | 'healthy'
  | 'blocked'
  | 'auth'
  | 'timeout'
  | 'model'
  | 'request'
  | 'quota'
  | 'upstream'
  | 'untested';

type MonitorIssue = {
  kind: MonitorIssueKind;
  label: string;
  hint: string;
  cls: string;
  priority: number;
};

const ISSUE_PRESENTATION: Record<MonitorIssueKind, MonitorIssue> = {
  healthy: {
    kind: 'healthy',
    label: '链路可用',
    hint: '最近探测成功',
    cls: 'badge-success',
    priority: 0,
  },
  blocked: {
    kind: 'blocked',
    label: '风控拦截',
    hint: '多半是线上出口 IP、WAF 或 Cloudflare 拦截',
    cls: 'badge-error',
    priority: 90,
  },
  auth: {
    kind: 'auth',
    label: '凭证异常',
    hint: '需要重新绑定 API Key、会话或 OAuth 凭证',
    cls: 'badge-error',
    priority: 80,
  },
  timeout: {
    kind: 'timeout',
    label: '网络超时',
    hint: '检查线上出口、DNS、代理或上游连通性',
    cls: 'badge-warning',
    priority: 70,
  },
  model: {
    kind: 'model',
    label: '模型不支持',
    hint: '当前站点或凭证不支持该模型',
    cls: 'badge-warning',
    priority: 60,
  },
  request: {
    kind: 'request',
    label: '参数/协议',
    hint: '请求格式、协议端点或参数需要调整',
    cls: 'badge-warning',
    priority: 50,
  },
  quota: {
    kind: 'quota',
    label: '限流/额度',
    hint: '上游限流、余额不足或额度耗尽',
    cls: 'badge-warning',
    priority: 45,
  },
  upstream: {
    kind: 'upstream',
    label: '上游失败',
    hint: '上游返回异常，需看原始原因',
    cls: 'badge-muted',
    priority: 30,
  },
  untested: {
    kind: 'untested',
    label: '未检测',
    hint: '尚无实时探测结果',
    cls: 'badge-muted',
    priority: 0,
  },
};

function formatLatency(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${Math.round(value)} ms`;
}

function formatCheckedAt(value: string | null | undefined): string {
  if (!value) return '-';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  return time.toLocaleTimeString();
}

function getStatusPresentation(status?: ProbeStatus | 'untested'): { label: string; cls: string } {
  if (status === 'supported') return { label: '可用', cls: 'badge-success' };
  if (status === 'unsupported') return { label: '不可用', cls: 'badge-error' };
  if (status === 'skipped') return { label: '跳过', cls: 'badge-muted' };
  if (status === 'inconclusive') return { label: '不确定', cls: 'badge-warning' };
  if (status === 'untested') return { label: '未检测', cls: 'badge-muted' };
  return { label: '未检测', cls: 'badge-muted' };
}

function classifyProbeIssue(result: ProbeResult | undefined): MonitorIssue {
  if (!result) return ISSUE_PRESENTATION.untested;
  if (result.status === 'supported') return ISSUE_PRESENTATION.healthy;

  const reason = `${result.reason || ''}`.toLowerCase();
  if (
    /cloudflare|captcha|challenge|waf|blocked|access denied|forbidden|request was blocked|防护|风控|拦截/.test(reason)
    || (/http\s*403/.test(reason) && !/invalid|unauthori[sz]ed|token|key/.test(reason))
  ) {
    return ISSUE_PRESENTATION.blocked;
  }
  if (/unauthori[sz]ed|invalid access token|invalid api key|expired|token.*invalid|key.*invalid|no auth available|auth_unavailable|401|凭证|令牌|过期|无效|重新绑定/.test(reason)) {
    return ISSUE_PRESENTATION.auth;
  }
  if (/timeout|timed out|etimedout|econnreset|econnrefused|fetch failed|network|dns|enotfound|eai_again|超时|连接失败/.test(reason)) {
    return ISSUE_PRESENTATION.timeout;
  }
  if (/model not found|no such model|unsupported model|model.*not.*support|does not support.*model|unknown model|模型.*不支持|不支持.*模型|模型.*不存在/.test(reason)) {
    return ISSUE_PRESENTATION.model;
  }
  if (/bad request|http\s*400|validation|invalid request|parameter|param|schema|payload|unsupported endpoint|protocol|参数|格式|协议|端点/.test(reason)) {
    return ISSUE_PRESENTATION.request;
  }
  if (/rate limit|quota|insufficient|balance|credit|billing|limit exceeded|额度|余额|限流/.test(reason)) {
    return ISSUE_PRESENTATION.quota;
  }

  return ISSUE_PRESENTATION.upstream;
}

function summarizeDominantIssue(results: ProbeResult[]): MonitorIssue {
  if (results.length === 0) return ISSUE_PRESENTATION.untested;
  const issues = results.map((result) => classifyProbeIssue(result));
  return issues.reduce((current, next) => (next.priority > current.priority ? next : current), ISSUE_PRESENTATION.healthy);
}

export default function Monitors() {
  const toast = useToast();
  const [candidates, setCandidates] = useState<MonitorCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [autoProbe, setAutoProbe] = useState(false);
  const [resultsById, setResultsById] = useState<Record<string, ProbeResult>>({});
  const [expandedSiteKeys, setExpandedSiteKeys] = useState<Record<string, boolean>>({});

  const recommended = useMemo(
    () => candidates.filter((candidate) => candidate.recommended),
    [candidates],
  );
  const latestResults = Object.values(resultsById);
  const supportedCount = latestResults.filter((result) => result.status === 'supported').length;
  const failedCount = latestResults.filter((result) => result.status === 'unsupported').length;
  const issueStats = useMemo(() => {
    const stats: Record<MonitorIssueKind, number> = {
      healthy: 0,
      blocked: 0,
      auth: 0,
      timeout: 0,
      model: 0,
      request: 0,
      quota: 0,
      upstream: 0,
      untested: 0,
    };
    for (const result of latestResults) {
      stats[classifyProbeIssue(result).kind] += 1;
    }
    return stats;
  }, [latestResults]);
  const siteGroups = useMemo<SiteMonitorGroup[]>(() => {
    const map = new Map<string, MonitorCandidate[]>();
    for (const candidate of candidates) {
      const key = String(candidate.siteId || candidate.siteName || 'unknown');
      const list = map.get(key) || [];
      list.push(candidate);
      map.set(key, list);
    }

    return Array.from(map.entries()).map(([key, groupCandidates]) => {
      const latencies = groupCandidates
        .map((candidate) => resultsById[candidate.id]?.latencyMs ?? candidate.lastKnownLatencyMs)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const checkedTimes = groupCandidates
        .map((candidate) => resultsById[candidate.id]?.checkedAt || candidate.lastCheckedAt)
        .filter((value): value is string => !!value)
        .sort((left, right) => new Date(right).getTime() - new Date(left).getTime());
      const groupResults = groupCandidates
        .map((candidate) => resultsById[candidate.id])
        .filter((result): result is ProbeResult => !!result);
      const groupFailed = groupResults.filter((result) => result.status === 'unsupported').length;
      const groupSupported = groupResults.filter((result) => result.status === 'supported').length;
      const inconclusive = groupResults.some((result) => result.status === 'inconclusive' || result.status === 'skipped');
      const issue = summarizeDominantIssue(groupResults);
      const status: SiteMonitorGroup['status'] = groupFailed > 0
        ? 'unsupported'
        : groupSupported > 0
          ? 'supported'
          : inconclusive
            ? 'inconclusive'
            : 'untested';

      return {
        key,
        siteId: groupCandidates[0]?.siteId || 0,
        siteName: groupCandidates[0]?.siteName || '未知站点',
        platform: groupCandidates[0]?.platform || '-',
        candidates: [...groupCandidates].sort((left, right) => {
          if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
          return left.costScore - right.costScore || left.modelName.localeCompare(right.modelName);
        }),
        recommendedCount: groupCandidates.filter((candidate) => candidate.recommended).length,
        testedCount: groupResults.length,
        supportedCount: groupSupported,
        failedCount: groupFailed,
        avgLatencyMs: latencies.length > 0
          ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
          : null,
        lastCheckedAt: checkedTimes[0] || null,
        status,
        issue,
      };
    }).sort((left, right) => {
      if (left.recommendedCount !== right.recommendedCount) return right.recommendedCount - left.recommendedCount;
      if (left.failedCount !== right.failedCount) return right.failedCount - left.failedCount;
      return left.siteName.localeCompare(right.siteName);
    });
  }, [candidates, resultsById]);

  const loadCandidates = async () => {
    setLoading(true);
    try {
      const res = await api.getMonitorModels({ limit: 100 }) as MonitorModelsResponse;
      const nextCandidates = Array.isArray(res?.candidates) ? res.candidates : [];
      setCandidates(nextCandidates);
      setExpandedSiteKeys((prev) => {
        if (Object.keys(prev).length > 0) return prev;
        const firstRecommended = nextCandidates.find((candidate) => candidate.recommended) || nextCandidates[0];
        return firstRecommended ? { [String(firstRecommended.siteId || firstRecommended.siteName || 'unknown')]: true } : {};
      });
    } catch (err: any) {
      toast.error(err?.message || '加载实时监测模型失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCandidates();
  }, []);

  const probeCandidate = async (candidate: MonitorCandidate, quiet = false): Promise<ProbeResult | null> => {
    setProbingId(candidate.id);
    try {
      const res = await api.probeMonitorModel({ candidateId: candidate.id, timeoutMs: 15_000 });
      const result = res?.result as ProbeResult | undefined;
      if (!result) throw new Error('检测结果为空');
      setResultsById((prev) => ({ ...prev, [candidate.id]: result }));
      if (!quiet) {
        const status = getStatusPresentation(result.status).label;
        toast.success(`${candidate.modelName} 检测完成：${status}`);
      }
      return result;
    } catch (err: any) {
      if (!quiet) toast.error(err?.message || '实时检测失败');
      return null;
    } finally {
      setProbingId(null);
    }
  };

  const probeRecommended = async (quiet = false) => {
    const target = recommended[0] || candidates[0];
    if (!target) {
      if (!quiet) toast.error('暂无可检测模型，请先同步模型或绑定可用 API Key');
      return;
    }
    await probeCandidate(target, quiet);
  };

  const probeSiteRecommended = async (group: SiteMonitorGroup, quiet = false) => {
    const target = group.candidates.find((candidate) => candidate.recommended) || group.candidates[0];
    if (!target) return;
    await probeCandidate(target, quiet);
  };

  const toggleSite = (siteKey: string) => {
    setExpandedSiteKeys((prev) => ({ ...prev, [siteKey]: !prev[siteKey] }));
  };

  useEffect(() => {
    if (!autoProbe) return undefined;
    const timer = window.setInterval(() => {
      void probeRecommended(true);
    }, 30_000);
    void probeRecommended(true);
    return () => window.clearInterval(timer);
  }, [autoProbe, recommended.length, candidates.length]);

  return (
    <div className="animate-fade-in monitor-page">
      <div className="monitor-toolbar page-header">
        <div>
          <h2 className="page-title">{tr('模型实时监测')}</h2>
          <div style={{ marginTop: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
            优先使用相对便宜的模型发起轻量 chat 探测，适合观察 sub2api/API Key 转发链路是否稳定。
          </div>
        </div>
        <div className="monitor-actions">
          <label className="monitor-auto-toggle">
            <input
              type="checkbox"
              checked={autoProbe}
              onChange={(event) => setAutoProbe(event.target.checked)}
            />
            <span>30 秒自动检测</span>
          </label>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => void loadCandidates()}
            disabled={loading}
          >
            刷新候选
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void probeRecommended()}
            disabled={loading || probingId !== null || candidates.length === 0}
          >
            {probingId ? '检测中...' : '检测推荐模型'}
          </button>
        </div>
      </div>

      <div className="monitor-summary-grid">
        <div className="monitor-summary-item">
          <span>监控站点</span>
          <strong>{siteGroups.length}</strong>
        </div>
        <div className="monitor-summary-item">
          <span>候选模型</span>
          <strong>{candidates.length}</strong>
        </div>
        <div className="monitor-summary-item">
          <span>低成本推荐</span>
          <strong>{recommended.length}</strong>
        </div>
        <div className="monitor-summary-item">
          <span>最近可用</span>
          <strong>{supportedCount}</strong>
        </div>
        <div className="monitor-summary-item">
          <span>最近失败</span>
          <strong>{failedCount}</strong>
        </div>
        <div className="monitor-summary-item">
          <span>风控/网络</span>
          <strong>{issueStats.blocked + issueStats.timeout}</strong>
        </div>
        <div className="monitor-summary-item">
          <span>凭证异常</span>
          <strong>{issueStats.auth}</strong>
        </div>
        <div className="monitor-summary-item">
          <span>模型/参数</span>
          <strong>{issueStats.model + issueStats.request}</strong>
        </div>
      </div>

      <div className="monitor-site-list">
        {loading ? (
          <div className="monitor-empty">正在加载模型候选...</div>
        ) : candidates.length === 0 ? (
          <div className="monitor-empty">
            暂无可监测模型。请先在站点或账号里同步模型，并确保 API Key/Token 处于可用状态。
          </div>
        ) : (
          siteGroups.map((group) => {
            const expanded = !!expandedSiteKeys[group.key];
            const siteStatus = getStatusPresentation(group.status);
            const probingInGroup = group.candidates.some((candidate) => candidate.id === probingId);
            return (
              <section className="monitor-site-card" key={group.key}>
                <button
                  type="button"
                  className="monitor-site-header"
                  onClick={() => toggleSite(group.key)}
                  aria-expanded={expanded}
                >
                  <span className="monitor-site-chevron" aria-hidden="true">{expanded ? 'v' : '>'}</span>
                  <span className="monitor-site-title-block">
                    <span className="monitor-site-title">{group.siteName}</span>
                    <span className="monitor-row-meta">
                      <span className="badge badge-muted">{group.platform}</span>
                      <span>{group.candidates.length} 个候选</span>
                      {group.recommendedCount > 0 ? <span>{group.recommendedCount} 个推荐</span> : null}
                    </span>
                  </span>
                  <span className="monitor-site-metrics">
                    <span className={`badge ${siteStatus.cls}`}>{siteStatus.label}</span>
                    <span className={`badge ${group.issue.cls}`} title={group.issue.hint}>{group.issue.label}</span>
                    <span>可用 {group.supportedCount}</span>
                    <span>失败 {group.failedCount}</span>
                    <span>延迟 {formatLatency(group.avgLatencyMs)}</span>
                    <span>最近 {formatCheckedAt(group.lastCheckedAt)}</span>
                  </span>
                </button>

                {expanded ? (
                  <div className="monitor-site-body">
                    <div className="monitor-site-body-toolbar">
                      <span>{group.testedCount > 0 ? `已检测 ${group.testedCount}/${group.candidates.length}` : '尚未检测'}</span>
                      <button
                        type="button"
                        className="btn btn-link"
                        onClick={() => void probeSiteRecommended(group)}
                        disabled={probingId !== null}
                      >
                        {probingInGroup ? '检测中' : '检测本站推荐'}
                      </button>
                    </div>
                    <div className="monitor-model-list">
                      {group.candidates.map((candidate) => {
                        const result = resultsById[candidate.id];
                        const status = getStatusPresentation(result?.status);
                        const issue = classifyProbeIssue(result);
                        return (
                          <div className="monitor-model-row" key={candidate.id}>
                            <div className="monitor-model-main">
                              <div className="monitor-model-name">{candidate.modelName}</div>
                              <div className="monitor-row-meta">
                                {candidate.recommended ? <span className="badge badge-info">推荐</span> : null}
                                <span className={`badge ${candidate.costScore <= 35 ? 'badge-success' : candidate.costScore <= 55 ? 'badge-info' : 'badge-warning'}`}>
                                  {candidate.costLabel}
                                </span>
                                <span>{candidate.kind === 'token' ? `API Key：${candidate.tokenName || candidate.tokenId}` : `账号：${candidate.username || candidate.accountId}`}</span>
                              </div>
                            </div>
                            <div className="monitor-model-state">
                              <span className={`badge ${status.cls}`}>{status.label}</span>
                              <span className={`badge ${issue.cls}`} title={issue.hint}>{issue.label}</span>
                              <span>{formatLatency(result?.latencyMs ?? candidate.lastKnownLatencyMs)}</span>
                              <span>{formatCheckedAt(result?.checkedAt || candidate.lastCheckedAt)}</span>
                            </div>
                            <div className="monitor-reason">{result?.reason || '等待实时检测'}</div>
                            <button
                              type="button"
                              className="btn btn-link monitor-model-action"
                              onClick={() => void probeCandidate(candidate)}
                              disabled={probingId !== null}
                            >
                              {probingId === candidate.id ? '检测中' : '检测'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
