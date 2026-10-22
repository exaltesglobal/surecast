import { BarChart3, Bell, CalendarDays, CalendarHeart, Inbox, LayoutDashboard, ListChecks, LogOut, Menu, Moon, PenSquare, Settings, Shield, Sun, Users, X } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { api, workspaceId } from '../lib/api';
import type { Client, Me } from '../lib/types';
import { Loading, Modal } from './ui';

type AppCtx = { me: Me; clients: Client[]; reloadClients: () => Promise<void>; alertCount: number; inboxCount: number; refreshAlerts: () => void; tz: string };
const Ctx = createContext<AppCtx | null>(null);
export const useApp = () => useContext(Ctx)!;

export function useTheme() {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('sc_theme') ?? 'light';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('sc_theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function Shell() {
  const nav = useNavigate();
  const loc = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [alertCount, setAlertCount] = useState(0);
  const [inboxCount, setInboxCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [plan, setPlan] = useState<WorkspaceInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('sc_dismissed') ?? '[]');
    } catch {
      return [];
    }
  });
  const dismiss = (id: string) => {
    const next = [...dismissed, id].slice(-50);
    setDismissed(next);
    try {
      localStorage.setItem('sc_dismissed', JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const reloadClients = async () => setClients((await api<{ clients: Client[] }>('/clients')).clients);
  const refreshAlerts = () => {
    api<{ alerts: unknown[] }>('/alerts')
      .then((r) => setAlertCount(r.alerts.length))
      .catch(() => undefined);
    api<{ open: number }>('/inbox?limit=1')
      .then((r) => setInboxCount(r.open))
      .catch(() => undefined);
  };

  useEffect(() => {
    api<Me>('/me')
      .then(async (m) => {
        if (m.workspaceId) workspaceId.set(m.workspaceId);
        setMe(m);
        api<{ workspace: WorkspaceInfo }>('/workspace')
          .then((r) => setPlan(r.workspace))
          .catch(() => undefined);
        await reloadClients();
        refreshAlerts();
      })
      .catch(() => nav(`/login?next=${encodeURIComponent(loc.pathname)}`, { replace: true }));
    const t = window.setInterval(refreshAlerts, 60_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setOpen(false), [loc.pathname]);

  if (!me) return <Loading />;
  const ws = me.workspaces.find((w) => w.id === me.workspaceId);
  const tz = ws?.timezone ?? 'UTC';

  return (
    <Ctx.Provider value={{ me, clients, reloadClients, alertCount, inboxCount, refreshAlerts, tz }}>
      {me.impersonating && (
        <div className="staff-bar" role="status">
          <Shield size={16} />
          <span>
            You are viewing <strong>{ws?.name}</strong> as {me.user.email}. Signed in as {me.impersonating.by}. Everything you do is logged.
          </span>
          <button
            onClick={async () => {
              await api('/impersonation/stop', { method: 'POST' });
              window.location.href = '/admin';
            }}
          >
            Back to admin
          </button>
        </div>
      )}
      <div className="mobile-bar">
        <button onClick={() => setOpen(!open)} aria-label="Menu">
          <Menu />
        </button>
        <strong style={{ fontFamily: 'var(--display)' }}>Surecast</strong>
        <NavLink to="/posts/new" style={{ color: '#fff' }} aria-label="New post">
          <PenSquare />
        </NavLink>
      </div>
      <div className="shell">
        <aside className={`sidebar ${open ? 'open' : ''}`}>
          <div className="brand">
            <img src="/mark-white.svg" alt="" />
            <span>
              Surecast<span className="dot">.</span>
            </span>
          </div>
          <NavLink to="/posts/new" className="btn accent block" style={{ marginBottom: 14 }}>
            <PenSquare size={16} /> New post
          </NavLink>
          <nav className="nav stack" style={{ gap: 2 }}>
            <NavItem to="/" icon={<LayoutDashboard size={18} />} end>
              Health
            </NavItem>
            <NavItem to="/calendar" icon={<CalendarDays size={18} />}>
              Calendar
            </NavItem>
            <NavItem to="/posts" icon={<ListChecks size={18} />}>
              Posts
            </NavItem>
            <NavItem to="/inbox" icon={<Inbox size={18} />} badge={inboxCount}>
              Inbox
            </NavItem>
            <NavItem to="/analytics" icon={<BarChart3 size={18} />}>
              Analytics
            </NavItem>
            <NavItem to="/clients" icon={<Users size={18} />}>
              Brands
            </NavItem>
            <NavItem to="/moments" icon={<CalendarHeart size={18} />}>
              Moments
            </NavItem>
            <NavItem to="/alerts" icon={<Bell size={18} />} badge={alertCount}>
              Alerts
            </NavItem>
            <NavItem to="/settings" icon={<Settings size={18} />}>
              Settings
            </NavItem>
            {me.staffRole && (
              <NavItem to="/admin" icon={<Shield size={18} />}>
                Surecast admin
              </NavItem>
            )}
          </nav>
          <div className="spacer" />
          <select
            value={me.workspaceId ?? ''}
            onChange={(e) => {
              if (e.target.value === '__new') return setCreating(true);
              workspaceId.set(e.target.value);
              window.location.href = '/';
            }}
            aria-label="Workspace"
            title="Switch workspace"
          >
            {me.workspaces.map((w) => (
              <option key={w.id} value={w.id} style={{ color: '#111' }}>
                {w.name}
              </option>
            ))}
            {!me.impersonating && (
              <option value="__new" style={{ color: '#111' }}>
                + New workspace…
              </option>
            )}
          </select>
          {creating && <NewWorkspace onClose={() => setCreating(false)} />}
          <div className="user">
            <span title={me.user.email} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {ws?.name}
              <br />
              <span className="tiny">{me.user.name || me.user.email}</span>
            </span>
            <span className="row" style={{ gap: 12, flexWrap: 'nowrap' }}>
              <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle dark mode" title="Dark mode">
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <button
                onClick={async () => {
                  await api('/auth/logout', { method: 'POST' });
                  window.location.href = '/login';
                }}
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut size={16} />
              </button>
            </span>
          </div>
        </aside>
        <main className="main">
          {plan?.suspended && (
            <div className="banner error announce">
              <div className="body">
                <strong>This workspace is suspended</strong>
                <p>
                  {plan.suspended.reason}. Nothing is being published and changes are switched off. Write to <a href="mailto:hello@surecast.live">hello@surecast.live</a> to sort it out.
                </p>
              </div>
            </div>
          )}
          {!plan?.suspended && plan?.plan.id === 'trial' && plan.plan.trialEndsAt && <TrialNotice endsAt={plan.plan.trialEndsAt} />}
          {me.announcements
            .filter((a) => !dismissed.includes(a.id))
            .map((a) => (
              <div key={a.id} className={`banner ${a.level === 'critical' ? 'error' : a.level} announce`}>
                <div className="body">
                  <strong>{a.title}</strong>
                  {a.body && <p>{a.body}</p>}
                </div>
                <button className="btn ghost sm" aria-label="Dismiss" onClick={() => dismiss(a.id)}>
                  <X size={14} />
                </button>
              </div>
            ))}
          <Outlet />
        </main>
      </div>
    </Ctx.Provider>
  );
}

function NewWorkspace({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ workspace: { id: string } }>('/workspaces', { body: { name, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
      workspaceId.set(r.workspace.id);
      window.location.href = '/';
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New workspace"
      onClose={onClose}
      footer={
        <button className="btn accent" disabled={busy || !name.trim()} onClick={create}>
          Create workspace
        </button>
      }
    >
      <p className="small muted">Each workspace has its own brands, channels, team and billing. Use one per agency client group, business unit or side project.</p>
      <label className="field">
        Name
        <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} placeholder="e.g. Acme Hospitality Group" />
      </label>
      {error && <div className="banner error">{error}</div>}
    </Modal>
  );
}

type WorkspaceInfo = { plan: { id: string; label: string; clientLimit: number | null; trialEndsAt: string | null }; suspended: { at: string; reason: string } | null };

function TrialNotice({ endsAt }: { endsAt: string }) {
  const days = Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000);
  if (days > 3) return null;
  return (
    <div className={`banner ${days <= 0 ? 'warning' : 'info'} announce`}>
      <div className="body">
        <strong>{days <= 0 ? 'Your free trial has ended' : `Your free trial ends in ${days} day${days === 1 ? '' : 's'}`}</strong>
        <p>
          Your posts keep going out. Pick a plan at <a href="https://surecast.live/#pricing">surecast.live/#pricing</a> or write to <a href="mailto:hello@surecast.live">hello@surecast.live</a>.
        </p>
      </div>
    </div>
  );
}

function NavItem({ to, icon, children, badge, end }: { to: string; icon: ReactNode; children: ReactNode; badge?: number; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => (isActive ? 'active' : '')}>
      {icon}
      {children}
      {!!badge && <span className="badge">{badge}</span>}
    </NavLink>
  );
}
