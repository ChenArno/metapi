import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import { useToast } from '../components/Toast.js';

type SitePoolStrategy = 'balanced' | 'cost_first' | 'stable_first' | 'round_robin' | 'backup_only';

type SitePoolMember = {
  id?: number;
  siteId: number;
  siteName?: string | null;
  accountId?: number | null;
  tokenId?: number | null;
  role?: 'primary' | 'backup' | 'disabled';
  weight?: number;
  sortOrder?: number;
};

type SitePool = {
  id: number;
  name: string;
  description?: string | null;
  strategy?: SitePoolStrategy | string | null;
  enabled?: boolean;
  members?: SitePoolMember[];
};

type SiteOption = {
  id: number;
  name: string;
  status?: string | null;
};

type PoolForm = {
  name: string;
  description: string;
  strategy: SitePoolStrategy;
  enabled: boolean;
  siteIds: number[];
};

const EMPTY_FORM: PoolForm = {
  name: '',
  description: '',
  strategy: 'balanced',
  enabled: true,
  siteIds: [],
};

const STRATEGY_OPTIONS: Array<{ value: SitePoolStrategy; label: string; desc: string }> = [
  { value: 'balanced', label: '均衡', desc: '按健康度和权重综合选择' },
  { value: 'stable_first', label: '稳定优先', desc: '优先使用稳定通道' },
  { value: 'round_robin', label: '轮询', desc: '在池内轮流分配' },
  { value: 'cost_first', label: '成本优先', desc: '优先低成本站点' },
  { value: 'backup_only', label: '仅备用', desc: '作为备用池使用' },
];

function strategyLabel(value?: string | null): string {
  return STRATEGY_OPTIONS.find((item) => item.value === value)?.label || '均衡';
}

function buildForm(pool?: SitePool | null): PoolForm {
  if (!pool) return EMPTY_FORM;
  return {
    name: pool.name || '',
    description: pool.description || '',
    strategy: STRATEGY_OPTIONS.some((item) => item.value === pool.strategy)
      ? pool.strategy as SitePoolStrategy
      : 'balanced',
    enabled: pool.enabled !== false,
    siteIds: Array.from(new Set((pool.members || []).map((member) => Number(member.siteId)).filter((id) => Number.isFinite(id) && id > 0))),
  };
}

export default function SitePools() {
  const toast = useToast();
  const [pools, setPools] = useState<SitePool[]>([]);
  const [sites, setSites] = useState<SiteOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingPool, setEditingPool] = useState<SitePool | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<PoolForm>(EMPTY_FORM);
  const [siteSearch, setSiteSearch] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [poolRes, siteRes] = await Promise.all([
        api.getSitePools(),
        api.getSites(),
      ]);
      setPools(Array.isArray(poolRes?.items) ? poolRes.items : []);
      const rawSites = Array.isArray(siteRes?.sites) ? siteRes.sites : Array.isArray(siteRes) ? siteRes : [];
      setSites(rawSites.map((site: any) => ({
        id: Number(site.id),
        name: String(site.name || site.url || `站点 ${site.id}`),
        status: site.status || null,
      })).filter((site: SiteOption) => Number.isFinite(site.id) && site.id > 0));
    } catch (error: any) {
      toast.error(error?.message || '加载站点池失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const siteMap = useMemo(() => new Map(sites.map((site) => [site.id, site])), [sites]);
  const filteredSites = useMemo(() => {
    const keyword = siteSearch.trim().toLowerCase();
    if (!keyword) return sites;
    return sites.filter((site) => site.name.toLowerCase().includes(keyword));
  }, [sites, siteSearch]);

  const openCreate = () => {
    setEditingPool(null);
    setForm(EMPTY_FORM);
    setSiteSearch('');
    setModalOpen(true);
  };

  const openEdit = (pool: SitePool) => {
    setEditingPool(pool);
    setForm(buildForm(pool));
    setSiteSearch('');
    setModalOpen(true);
  };

  const toggleSite = (siteId: number, checked: boolean) => {
    setForm((prev) => ({
      ...prev,
      siteIds: checked
        ? Array.from(new Set([...prev.siteIds, siteId]))
        : prev.siteIds.filter((id) => id !== siteId),
    }));
  };

  const savePool = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.info('请填写站点池名称');
      return;
    }
    if (form.siteIds.length === 0) {
      toast.info('请至少选择一个站点');
      return;
    }
    const payload = {
      name,
      description: form.description.trim() || null,
      strategy: form.strategy,
      enabled: form.enabled,
      members: form.siteIds.map((siteId, index) => ({
        siteId,
        role: 'primary',
        weight: 1,
        sortOrder: index,
      })),
    };
    setSaving(true);
    try {
      if (editingPool) {
        await api.updateSitePool(editingPool.id, payload);
        toast.success('站点池已更新');
      } else {
        await api.createSitePool(payload);
        toast.success('站点池已创建');
      }
      setModalOpen(false);
      await load();
    } catch (error: any) {
      toast.error(error?.message || '保存站点池失败');
    } finally {
      setSaving(false);
    }
  };

  const deletePool = async (pool: SitePool) => {
    if (!window.confirm(`确认删除站点池「${pool.name}」？已绑定的下游密钥会失去这个池。`)) return;
    try {
      await api.deleteSitePool(pool.id);
      toast.success('站点池已删除');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '删除站点池失败');
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h1 className="page-title">站点池</h1>
          <div className="page-subtitle">把一组上游站点打包成池，下游密钥可以绑定池来限制请求只走这些站点。</div>
        </div>
        <button className="btn btn-primary" onClick={openCreate}>+ 新建站点池</button>
      </div>

      {loading ? (
        <div className="skeleton" style={{ height: 160, borderRadius: 8 }} />
      ) : pools.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">暂无站点池</div>
          <div className="empty-state-desc">创建站点池后，就能在“密钥分配”里把下游密钥绑定到指定站点范围。</div>
          <button className="btn btn-primary" onClick={openCreate}>新建站点池</button>
        </div>
      ) : (
        <div className="site-pool-grid">
          {pools.map((pool) => {
            const members = Array.isArray(pool.members) ? pool.members : [];
            return (
              <section key={pool.id} className="site-pool-card">
                <div className="site-pool-card-header">
                  <div>
                    <div className="site-pool-title">{pool.name}</div>
                    <div className="site-pool-meta">
                      {pool.enabled === false ? '已停用' : '启用中'} · {strategyLabel(pool.strategy)} · {members.length} 个站点
                    </div>
                  </div>
                  <span className={`badge ${pool.enabled === false ? 'badge-muted' : 'badge-success'}`}>
                    {pool.enabled === false ? '停用' : '启用'}
                  </span>
                </div>
                {pool.description ? <div className="site-pool-desc">{pool.description}</div> : null}
                <div className="site-pool-members">
                  {members.length === 0 ? (
                    <span className="badge badge-muted">无成员</span>
                  ) : members.slice(0, 8).map((member) => (
                    <span key={`${member.siteId}:${member.accountId || 0}:${member.tokenId || 0}`} className="badge badge-muted">
                      {member.siteName || siteMap.get(member.siteId)?.name || `站点 ${member.siteId}`}
                    </span>
                  ))}
                  {members.length > 8 ? <span className="badge badge-info">+{members.length - 8}</span> : null}
                </div>
                <div className="site-pool-actions">
                  <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => openEdit(pool)}>编辑</button>
                  <button className="btn btn-link btn-link-danger" onClick={() => void deletePool(pool)}>删除</button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <CenteredModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingPool ? '编辑站点池' : '新建站点池'}
        maxWidth={720}
        bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={saving}>取消</button>
            <button className="btn btn-primary" onClick={savePool} disabled={saving}>
              {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存'}
            </button>
          </>
        )}
      >
        <div className="site-pool-form-grid">
          <label className="site-pool-field">
            <span>名称</span>
            <input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} placeholder="例如：superapi 主池" />
          </label>
          <label className="site-pool-field">
            <span>策略</span>
            <select value={form.strategy} onChange={(event) => setForm((prev) => ({ ...prev, strategy: event.target.value as SitePoolStrategy }))}>
              {STRATEGY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>

        <label className="site-pool-field">
          <span>说明</span>
          <textarea value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} placeholder="这个池分配给哪些客户端、用来做什么" />
        </label>

        <label className="downstream-key-modal-toggle">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm((prev) => ({ ...prev, enabled: event.target.checked }))} />
          <div>
            <div className="downstream-key-modal-toggle-title">启用站点池</div>
            <div className="downstream-key-modal-help">停用后，绑定这个池的下游密钥不会再从池内选站。</div>
          </div>
        </label>

        <div className="site-pool-field">
          <span>成员站点</span>
          <div className="toolbar-search" style={{ maxWidth: '100%' }}>
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input value={siteSearch} onChange={(event) => setSiteSearch(event.target.value)} placeholder="搜索站点" />
          </div>
          <div className="site-pool-site-list">
            {filteredSites.length === 0 ? (
              <div className="downstream-key-modal-help">暂无可选站点</div>
            ) : filteredSites.map((site) => {
              const checked = form.siteIds.includes(site.id);
              return (
                <label key={site.id} className={`site-pool-site-row ${checked ? 'is-selected' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={(event) => toggleSite(site.id, event.target.checked)} />
                  <span>{site.name}</span>
                  <small>{site.status === 'active' ? '启用' : site.status || '未知'}</small>
                </label>
              );
            })}
          </div>
        </div>
      </CenteredModal>
    </div>
  );
}
