// The Surecast team's admin panel. Only staff see it; what each person can change depends on
// their staff role, and every change is in the audit log.
import { Activity, Building2, ClipboardList, Eye, Gauge, Megaphone, RefreshCw, Shield, Users } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { useApp } from '../components/Layout';
import { Empty, ErrorBanner, Loading, Modal, Pill, PlatformBadge, Spinner, useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';
import { platformInfo } from '../lib/platforms';
import { ago, fmt } from '../lib/time';

type AdminMe = { role: string; permissions: string[]; plans: Record<string, { label: string; clients: number | null; priceInr: number | null }> };
type Ws = {
  id: string;
  name: string;
  plan: string;
  planLabel: string;
  trialEndsAt: string | null;
  suspended: { at: string; reason: string } | null;
  createdAt: string;
  owner: string | null;
  members: number;
  clients: number;
  channels: number;
  failed7: number;
  lastActiveAt: string | null;
};

const TABS = [
  { id: 'overview', label: 'Overview', icon: <Gauge size={16} /> },
  { id: 'workspaces', label: 'Workspaces', icon: <Building2 size={16} /> },
  { id: 'people', label: 'People', icon: <Users size={16} /> },
  { id: 'health', label: 'Publishing', icon: <Activity size={16} /> },
  { id: 'announcements', label: 'Announcements', icon: <Megaphone size={16} /> },
  { id: 'staff', label: 'Staff', icon: <Shield size={16} /> },
  { id: 'audit', label: 'Audit log', icon: <ClipboardList size={16} />, perm: 'audit' },
];

export function AdminPage() {
  const { me } = useApp();
  const { data, error } = useLoad(() => api<AdminMe>('/admin/me'));
  const [tab, setTab] = useState(() => location.hash.slice(1) || 'overview');
  if (!me.staffRole) return <Empty title="Page not found" />;
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Loading />;
  const can = (p: string) => data.permissions.includes(p);
  const go = (t: string) => {
    setTab(t);
    history.replaceState(null, '', `#${t}`);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Surecast admin</h1>
          <p>
            Every workspace on the service. You are <strong>{data.role}</strong>. Changes are logged.
          </p>
        </div>
      </div>
      <div className="admin-layout">
        <nav className="admin-nav" aria-label="Admin sections">
          {TABS.filter((t) => !t.perm || can(t.perm)).map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => go(t.id)}>
              {t.icon} {t.label}
            </button>
          ))}
        </nav>
        <div className="stack" style={{ minWidth: 0 }}>
          {tab === 'overview' && <Overview onOpen={() => go('workspaces')} />}
          {tab === 'workspaces' && <Workspaces can={can} plans={data.plans} />}
          {tab === 'people' && <People />}
          {tab === 'health' && <Health can={can} />}
          {tab === 'announcements' && <Announcements can={can} />}
          {tab === 'staff' && <Staff can={can} />}
          {tab === 'audit' && can('audit') && <Audit />}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className={`card stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

type Overview = {
  workspaces: { total: number; suspended: number; new7: number; byPlan: Record<string, number> };
  users: { total: number; new7: number; active7: number };
  publishing: { published24: number; published7: number; failed7: number; successRate7: number | null; scheduled: number; awaitingApproval: number; paused: number; stuck: number };
  channels: { total: number; disconnected: number; warning: number };
  ai: { requests7: number; inputTokens7: number; outputTokens7: number };
  signups: { day: string; count: number }[];
  trialsEnding: { id: string; name: string; trialEndsAt: string }[];
  scheduler: { lastTickAt: string; source: string; healthy: boolean } | null;
};

function Overview({ onOpen }: { onOpen: () => void }) {
  const { data, error, reload, loading } = useLoad(() => api<Overview>('/admin/overview'));
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Loading />;
  const p = data.publishing;
  const max = Math.max(1, ...data.signups.map((s) => s.count));
  return (
    <>
      <div className="row between">
        <span className="small muted">
          Scheduler {data.scheduler ? (data.scheduler.healthy ? 'healthy' : 'NOT ticking') : 'has never run'}
          {data.scheduler && ` · last tick ${ago(data.scheduler.lastTickAt)} (${data.scheduler.source})`}
        </span>
        <button className="btn sm" onClick={reload} disabled={loading}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div className="grid stats">
        <Stat label="Workspaces" value={data.workspaces.total} sub={`${data.workspaces.new7} new this week · ${data.workspaces.suspended} suspended`} />
        <Stat label="People" value={data.users.total} sub={`${data.users.active7} signed in this week`} />
        <Stat label="Posted in 24 hours" value={p.published24} sub={`${p.published7} in 7 days`} />
        <Stat label="Success rate, 7 days" value={p.successRate7 == null ? '–' : `${p.successRate7}%`} sub={`${p.failed7} failed`} tone={p.successRate7 != null && p.successRate7 < 98 ? 'bad' : 'good'} />
        <Stat label="Scheduled" value={p.scheduled} sub={`${p.awaitingApproval} awaiting approval · ${p.paused} paused`} />
        <Stat label="Stuck" value={p.stuck} sub="Due 15+ minutes ago" tone={p.stuck ? 'bad' : undefined} />
        <Stat label="Channels" value={data.channels.total} sub={`${data.channels.disconnected} disconnected`} tone={data.channels.disconnected ? 'bad' : undefined} />
        <Stat label="AI requests, 7 days" value={data.ai.requests7} sub={`${Math.round((data.ai.inputTokens7 + data.ai.outputTokens7) / 1000)}k tokens`} />
      </div>
      <div className="grid two">
        <section className="card pad stack">
          <h3 style={{ margin: 0 }}>Sign-ups, last 30 days</h3>
          {data.signups.length ? (
            <div className="bars" aria-label="New workspaces per day">
              {data.signups.map((s) => (
                <span key={s.day} style={{ height: `${(s.count / max) * 100}%` }} title={`${s.day}: ${s.count}`} />
              ))}
            </div>
          ) : (
            <span className="small muted">No new workspaces in 30 days.</span>
          )}
          <div className="row" style={{ gap: 6 }}>
            {Object.entries(data.workspaces.byPlan).map(([plan, n]) => (
              <span key={plan} className="pill neutral">
                {plan}: {n}
              </span>
            ))}
          </div>
        </section>
        <section className="card pad stack">
          <h3 style={{ margin: 0 }}>Trials ending in 3 days</h3>
          {data.trialsEnding.length ? (
            data.trialsEnding.map((t) => (
              <div key={t.id} className="row between small">
                <span>{t.name}</span>
                <span className="muted">{fmt(t.trialEndsAt, undefined, { dateStyle: 'medium' })}</span>
              </div>
            ))
          ) : (
            <span className="small muted">None.</span>
          )}
          <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={onOpen}>
            All workspaces
          </button>
        </section>
      </div>
    </>
  );
}

function Workspaces({ can, plans }: { can: (p: string) => boolean; plans: AdminMe['plans'] }) {
  const [q, setQ] = useState('');
  const [plan, setPlan] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useLoad(() => api<{ workspaces: Ws[]; total: number }>(`/admin/workspaces?q=${encodeURIComponent(search)}&plan=${plan}&status=${status}`), [search, plan, status]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
        }}
      >
        <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, owner email or workspace id" style={{ minWidth: 200 }} />
        <select className="input" value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Plan" style={{ width: 'auto' }}>
          <option value="">All plans</option>
          {Object.entries(plans).map(([id, p]) => (
            <option key={id} value={id}>
              {p.label}
            </option>
          ))}
        </select>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" style={{ width: 'auto' }}>
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="trial_expired">Trial ended</option>
        </select>
        <button className="btn">Search</button>
      </form>
      <ErrorBanner error={error} />
      <section className="card" style={{ overflowX: 'auto' }}>
        {loading && !data ? (
          <Loading />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Plan</th>
                <th className="num">Clients</th>
                <th className="num">Channels</th>
                <th className="num">Failed 7d</th>
                <th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {data?.workspaces.map((w) => (
                <tr key={w.id} onClick={() => setOpen(w.id)} style={{ cursor: 'pointer' }}>
                  <td>
                    <strong>{w.name}</strong> {w.suspended && <Pill status="failed">Suspended</Pill>}
                    <div className="tiny muted">{w.owner ?? 'no owner'}</div>
                  </td>
                  <td>
                    {w.planLabel}
                    {w.plan === 'trial' && w.trialEndsAt && <div className="tiny muted">ends {fmt(w.trialEndsAt, undefined, { dateStyle: 'medium' })}</div>}
                  </td>
                  <td className="num">{w.clients}</td>
                  <td className="num">{w.channels}</td>
                  <td className="num" style={{ color: w.failed7 ? 'var(--error)' : undefined }}>
                    {w.failed7}
                  </td>
                  <td className="tiny">{w.lastActiveAt ? ago(w.lastActiveAt) : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && !data.workspaces.length && <Empty title="No workspaces match" />}
      </section>
      {data && <span className="tiny muted">{data.total} workspaces</span>}
      {open && <WorkspaceModal id={open} can={can} plans={plans} onClose={() => setOpen(null)} onChanged={reload} />}
    </>
  );
}

type Detail = {
  workspace: Ws & { staffNotes: string; clientLimit: number | null; aiRequests30: number; timezone: string };
  members: { id: string; email: string; name: string; role: string }[];
  clients: { id: string; name: string; pausedAt: string | null; pausedReason: string | null; archivedAt: string | null }[];
  channels: { id: string; platform: string; name: string; handle: string; status: string; statusMessage: string | null }[];
  failures: { id: string; postId: string; code: string; message: string; at: string; platform: string; channel: string }[];
  audit: { id: string; actor: string; action: string; target: string | null; at: string }[];
};

function WorkspaceModal({ id, can, plans, onClose, onChanged }: { id: string; can: (p: string) => boolean; plans: AdminMe['plans']; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => api<Detail>(`/admin/workspaces/${id}`), [id]);
  const [notes, setNotes] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setErr(null);
    try {
      await fn();
      await reload();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (error) return <Modal title="Workspace" onClose={onClose}><ErrorBanner error={error} /></Modal>;
  if (!data) return <Modal title="Workspace" onClose={onClose}><Loading /></Modal>;
  const w = data.workspace;
  return (
    <Modal title={w.name} onClose={onClose}>
      {w.suspended && (
        <div className="banner error">
          <div className="body">
            <strong>Suspended {ago(w.suspended.at)}</strong>
            <p>{w.suspended.reason}</p>
          </div>
        </div>
      )}
      <dl className="kv">
        <dt>Id</dt>
        <dd className="mono">{w.id}</dd>
        <dt>Owner</dt>
        <dd>{w.owner ?? '–'}</dd>
        <dt>Created</dt>
        <dd>{fmt(w.createdAt, undefined, { dateStyle: 'medium' })}</dd>
        <dt>Clients</dt>
        <dd>
          {w.clients} of {w.clientLimit ?? 'unlimited'}
        </dd>
        <dt>AI requests, 30 days</dt>
        <dd>{w.aiRequests30}</dd>
      </dl>
      {can('workspaces.manage') && (
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={w.plan} disabled={!!busy} onChange={(e) => act('plan', async () => void (await api(`/admin/workspaces/${id}`, { method: 'PATCH', body: { plan: e.target.value } })))} aria-label="Plan">
            {Object.entries(plans).map(([pid, p]) => (
              <option key={pid} value={pid}>
                {p.label}
                {p.priceInr ? ` (₹${p.priceInr})` : ''}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!!busy} onClick={() => act('extend', async () => void (await api(`/admin/workspaces/${id}`, { method: 'PATCH', body: { extendTrialDays: 7 } })))}>
            Extend trial 7 days
          </button>
          {w.trialEndsAt && <span className="tiny muted">Trial ends {fmt(w.trialEndsAt, undefined, { dateStyle: 'medium' })}</span>}
        </div>
      )}
      <div className="row">
        {can('impersonate') && (
          <button
            className="btn sm"
            disabled={!!busy}
            onClick={() =>
              act('imp', async () => {
                const reason = prompt('Why do you need to see this workspace? (goes in the audit log)');
                if (!reason) return;
                await api(`/admin/workspaces/${id}/impersonate`, { body: { reason } });
                localStorage.setItem('sc_workspace', id);
                window.location.href = '/';
              })
            }
          >
            <Eye size={14} /> View as customer
          </button>
        )}
        {can('workspaces.suspend') &&
          (w.suspended ? (
            <button className="btn sm" disabled={!!busy} onClick={() => act('unsuspend', async () => toast(`Unsuspended. ${(await api<{ resumed: number }>(`/admin/workspaces/${id}/unsuspend`, { method: 'POST' })).resumed} posts back on schedule.`))}>
              Unsuspend
            </button>
          ) : (
            <button
              className="btn sm danger"
              disabled={!!busy}
              onClick={() =>
                act('suspend', async () => {
                  const reason = prompt('Reason for suspending (the customer sees this)');
                  if (!reason) return;
                  const r = await api<{ held: number }>(`/admin/workspaces/${id}/suspend`, { body: { reason } });
                  toast(`Suspended. ${r.held} posts held.`);
                })
              }
            >
              Suspend
            </button>
          ))}
        {can('workspaces.delete') && (
          <button
            className="btn sm ghost danger"
            disabled={!!busy}
            onClick={async () => {
              const confirmName = prompt(`This deletes "${w.name}" and everything in it, for good. Type the workspace name to confirm.`);
              if (!confirmName) return;
              try {
                await api(`/admin/workspaces/${id}`, { method: 'DELETE', body: { confirm: confirmName } });
                toast('Workspace deleted');
                onChanged();
                onClose();
              } catch (e) {
                setErr((e as Error).message);
              }
            }}
          >
            Delete workspace
          </button>
        )}
        {busy && <Spinner />}
      </div>
      <ErrorBanner error={err} />
      {can('workspaces.manage') && (
        <label className="field">
          Staff notes <span className="hint">Only the Surecast team sees these.</span>
          <textarea className="input" rows={3} value={notes ?? w.staffNotes} onChange={(e) => setNotes(e.target.value)} />
          {notes != null && notes !== w.staffNotes && (
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => act('notes', async () => void (await api(`/admin/workspaces/${id}`, { method: 'PATCH', body: { staffNotes: notes } })))}>
              Save notes
            </button>
          )}
        </label>
      )}
      <strong className="small">Members</strong>
      {data.members.map((m) => (
        <div key={m.id} className="row between small">
          <span>
            {m.name || m.email} <span className="tiny muted">{m.email}</span>
          </span>
          <span className="pill neutral">{m.role}</span>
        </div>
      ))}
      <strong className="small">Clients and channels</strong>
      {data.clients.map((c) => (
        <div key={c.id} className="small">
          {c.name} {c.pausedAt && <Pill status="paused" />} {c.archivedAt && <span className="tiny muted">archived</span>}
        </div>
      ))}
      <div className="row" style={{ gap: 6 }}>
        {data.channels.map((ch) => (
          <span key={ch.id} className="chip" title={ch.statusMessage ?? ''} style={{ paddingRight: 10 }}>
            <PlatformBadge platform={ch.platform} size={16} /> {ch.name} <Pill status={ch.status} />
          </span>
        ))}
      </div>
      {!!data.failures.length && (
        <>
          <strong className="small">Recent failures</strong>
          {data.failures.slice(0, 8).map((f) => (
            <div key={f.id} className="tiny">
              <span className="muted">{ago(f.at)}</span> · {platformInfo(f.platform ?? '').label} {f.channel}: <span style={{ color: 'var(--error)' }}>{f.message}</span>
            </div>
          ))}
        </>
      )}
      {!!data.audit.length && (
        <>
          <strong className="small">Staff activity</strong>
          {data.audit.slice(0, 8).map((a) => (
            <div key={a.id} className="tiny muted">
              {ago(a.at)} · {a.actor} · {a.action}
              {a.target ? ` · ${a.target}` : ''}
            </div>
          ))}
        </>
      )}
      <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => nav(`/admin#audit`)}>
        Full audit log
      </button>
    </Modal>
  );
}

function People() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, error } = useLoad(() => api<{ users: { id: string; email: string; name: string; createdAt: string; staffRole: string | null; lastSignInAt: string | null; workspaces: string | null }[] }>(`/admin/users?q=${encodeURIComponent(search)}`), [search]);
  return (
    <>
      <form className="row" onSubmit={(e) => (e.preventDefault(), setSearch(q))}>
        <input className="input grow" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Email, name or user id" />
        <button className="btn">Search</button>
      </form>
      <ErrorBanner error={error} />
      <section className="card" style={{ overflowX: 'auto' }}>
        {!data ? (
          <Loading />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Workspaces</th>
                <th>Last sign-in</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name || u.email}</strong> {u.staffRole && <span className="pill neutral">staff: {u.staffRole}</span>}
                    <div className="tiny muted">{u.email}</div>
                  </td>
                  <td className="small">{u.workspaces ?? '–'}</td>
                  <td className="tiny">{u.lastSignInAt ? ago(u.lastSignInAt) : 'never'}</td>
                  <td className="tiny">{fmt(u.createdAt, undefined, { dateStyle: 'medium' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

type HealthData = {
  platforms: { platform: string; published: number; failed: number; successRate: number | null }[];
  errors: { code: string; count: number; example: string | null }[];
  stuck: { id: string; postId: string; workspaceId: string; workspace: string; status: string; nextAttemptAt: string; code: string | null }[];
  disconnected: { id: string; platform: string; name: string; message: string | null; workspace: string; lastCheckedAt: string | null }[];
};

function Health({ can }: { can: (p: string) => boolean }) {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api<HealthData>('/admin/health'));
  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Loading />;
  return (
    <>
      <section className="card">
        <div className="card-head">
          <h2>By network, last 7 days</h2>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Network</th>
              <th className="num">Posted</th>
              <th className="num">Failed</th>
              <th className="num">Success</th>
            </tr>
          </thead>
          <tbody>
            {data.platforms.map((p) => (
              <tr key={p.platform}>
                <td>
                  <PlatformBadge platform={p.platform} size={16} /> {platformInfo(p.platform).label}
                </td>
                <td className="num">{p.published}</td>
                <td className="num">{p.failed}</td>
                <td className="num">{p.successRate == null ? '–' : `${p.successRate}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.platforms.length && <Empty title="Nothing published this week yet" />}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Why posts failed, last 7 days</h2>
        </div>
        {data.errors.length ? (
          <div className="list">
            {data.errors.map((e) => (
              <div key={e.code} className="list-item">
                <strong className="mono">{e.code}</strong>
                <span className="grow tiny muted">{e.example}</span>
                <span className="pill error">{e.count}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No failures this week" />
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Stuck posts</h2>
          {can('publishing.ops') && !!data.stuck.length && (
            <button
              className="btn sm"
              onClick={async () => {
                const r = await api<{ requeued: number }>('/admin/targets/requeue', { body: { ids: data.stuck.map((s) => s.id) } });
                toast(`${r.requeued} put back in the queue`);
                reload();
              }}
            >
              Requeue all
            </button>
          )}
        </div>
        {data.stuck.length ? (
          <div className="list">
            {data.stuck.map((s) => (
              <div key={s.id} className="list-item small">
                <span className="grow">
                  {s.workspace} · <span className="mono tiny">{s.id}</span>
                </span>
                <Pill status={s.status} />
                <span className="tiny muted">due {ago(s.nextAttemptAt)}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="Nothing stuck" />
        )}
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Disconnected channels</h2>
        </div>
        {data.disconnected.length ? (
          <div className="list">
            {data.disconnected.map((d) => (
              <div key={d.id} className="list-item small">
                <PlatformBadge platform={d.platform} size={18} />
                <span className="grow">
                  {d.name} · {d.workspace}
                  <div className="tiny muted">{d.message}</div>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="All channels connected" />
        )}
      </section>
    </>
  );
}

type Ann = { id: string; title: string; body: string; level: string; startsAt: string; endsAt: string | null };

function Announcements({ can }: { can: (p: string) => boolean }) {
  const { data, reload } = useLoad(() => api<{ announcements: Ann[] }>('/admin/announcements'));
  const [form, setForm] = useState({ title: '', body: '', level: 'info', endsAt: '' });
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();
  return (
    <>
      {can('announcements') && (
        <section className="card pad stack">
          <h3 style={{ margin: 0 }}>New announcement</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Shows as a banner to every signed-in customer until it ends or they dismiss it.
          </p>
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Instagram publishing is delayed" aria-label="Title" />
          <textarea className="input" rows={2} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Details (optional)" aria-label="Details" />
          <div className="row">
            <select className="input" style={{ width: 'auto' }} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} aria-label="Level">
              <option value="info">Info</option>
              <option value="success">Good news</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
            <label className="small row" style={{ gap: 6 }}>
              Ends
              <input className="input" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} style={{ width: 'auto' }} />
            </label>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await api('/admin/announcements', { body: { ...form, endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null } });
                  setForm({ title: '', body: '', level: 'info', endsAt: '' });
                  setError(null);
                  reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Publish
            </button>
          </div>
          <ErrorBanner error={error} />
        </section>
      )}
      <section className="card">
        {data?.announcements.length ? (
          <div className="list">
            {data.announcements.map((a) => {
              const live = new Date(a.startsAt).getTime() <= now && (!a.endsAt || new Date(a.endsAt).getTime() > now);
              return (
                <div key={a.id} className="list-item">
                  <span className="grow">
                    <strong>{a.title}</strong> <span className={`pill ${live ? 'success' : 'neutral'}`}>{live ? 'Live' : 'Ended'}</span>
                    <div className="tiny muted">
                      {a.level} · from {fmt(a.startsAt)}
                      {a.endsAt ? ` to ${fmt(a.endsAt)}` : ''}
                    </div>
                  </span>
                  {can('announcements') && live && (
                    <button className="btn sm" onClick={async () => (await api(`/admin/announcements/${a.id}`, { method: 'PATCH', body: { ...a, endsAt: new Date().toISOString() } }), reload())}>
                      End now
                    </button>
                  )}
                  {can('announcements') && (
                    <button className="btn ghost sm danger" onClick={async () => (await api(`/admin/announcements/${a.id}`, { method: 'DELETE' }), reload())}>
                      Delete
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <Empty title="No announcements yet" />
        )}
      </section>
    </>
  );
}

function Staff({ can }: { can: (p: string) => boolean }) {
  const { data, reload } = useLoad(() =>
    api<{ staff: { id: string | null; email: string; name: string; role: string; fixed: boolean }[]; roles: Record<string, string>; permissions: Record<string, string[]> }>('/admin/staff'),
  );
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('support');
  const [error, setError] = useState<string | null>(null);
  if (!data) return <Loading />;
  return (
    <>
      <section className="card">
        <div className="list">
          {data.staff.map((s) => (
            <div key={s.email} className="list-item">
              <span className="grow">
                <strong>{s.name || s.email}</strong>
                <div className="tiny muted">
                  {s.email}
                  {s.fixed && ' · from ADMIN_EMAILS'}
                </div>
              </span>
              <span className="pill neutral">{s.role}</span>
              {can('staff') && !s.fixed && s.id && (
                <button
                  className="btn ghost sm danger"
                  onClick={async () => {
                    if (!confirm(`Remove ${s.email} from the Surecast team?`)) return;
                    await api(`/admin/staff/${s.id}`, { method: 'DELETE' });
                    reload();
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
      {can('staff') && (
        <section className="card pad stack">
          <h3 style={{ margin: 0 }}>Add someone to the team</h3>
          <div className="row">
            <input className="input grow" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@surecast.live" />
            <select className="input" style={{ width: 'auto' }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              {Object.keys(data.roles).map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await api('/admin/staff', { body: { email, role } });
                  setEmail('');
                  setError(null);
                  reload();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Add
            </button>
          </div>
          <ErrorBanner error={error} />
        </section>
      )}
      <section className="card pad stack">
        <h3 style={{ margin: 0 }}>Roles</h3>
        {Object.entries(data.roles).map(([r, text]) => (
          <div key={r} className="small">
            <strong>{r}</strong>: {text}
          </div>
        ))}
      </section>
    </>
  );
}

function Audit() {
  const [actor, setActor] = useState('');
  const [filter, setFilter] = useState('');
  const { data, error } = useLoad(() => api<{ entries: { id: string; actor: string; action: string; workspaceId: string | null; target: string | null; detail: string | null; ip: string | null; at: string }[] }>(`/admin/audit?actor=${encodeURIComponent(filter)}`), [filter]);
  return (
    <>
      <form className="row" onSubmit={(e) => (e.preventDefault(), setFilter(actor))}>
        <input className="input grow" value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Filter by staff email" />
        <button className="btn">Filter</button>
      </form>
      <ErrorBanner error={error} />
      <section className="card" style={{ overflowX: 'auto' }}>
        {!data ? (
          <Loading />
        ) : data.entries.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="tiny">{fmt(e.at)}</td>
                  <td className="small">
                    {e.actor}
                    {e.ip && <div className="tiny muted">{e.ip}</div>}
                  </td>
                  <td className="small">
                    <span className="mono">{e.action}</span>
                    {e.target && <div className="tiny muted">{e.target}</div>}
                    {e.workspaceId && <div className="tiny muted mono">{e.workspaceId}</div>}
                  </td>
                  <td className="tiny mono" style={{ maxWidth: 320, wordBreak: 'break-word' }}>
                    {e.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Nothing logged yet" />
        )}
      </section>
    </>
  );
}
