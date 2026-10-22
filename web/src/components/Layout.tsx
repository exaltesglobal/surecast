import { Bell, CalendarDays, LayoutDashboard, ListChecks, LogOut, Menu, Moon, PenSquare, Settings, Sun, Users } from 'lucide-react';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';

import { api, workspaceId } from '../lib/api';
import type { Client, Me } from '../lib/types';
import { Loading } from './ui';

type AppCtx = { me: Me; clients: Client[]; reloadClients: () => Promise<void>; alertCount: number; refreshAlerts: () => void; tz: string };
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
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();

  const reloadClients = async () => setClients((await api<{ clients: Client[] }>('/clients')).clients);
  const refreshAlerts = () =>
    api<{ alerts: unknown[] }>('/alerts')
      .then((r) => setAlertCount(r.alerts.length))
      .catch(() => undefined);

  useEffect(() => {
    api<Me>('/me')
      .then(async (m) => {
        if (m.workspaceId) workspaceId.set(m.workspaceId);
        setMe(m);
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
    <Ctx.Provider value={{ me, clients, reloadClients, alertCount, refreshAlerts, tz }}>
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
            <NavItem to="/clients" icon={<Users size={18} />}>
              Clients
            </NavItem>
            <NavItem to="/alerts" icon={<Bell size={18} />} badge={alertCount}>
              Alerts
            </NavItem>
            <NavItem to="/settings" icon={<Settings size={18} />}>
              Settings
            </NavItem>
          </nav>
          <div className="spacer" />
          {me.workspaces.length > 1 && (
            <select
              value={me.workspaceId ?? ''}
              onChange={(e) => {
                workspaceId.set(e.target.value);
                window.location.href = '/';
              }}
              aria-label="Workspace"
            >
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id} style={{ color: '#111' }}>
                  {w.name}
                </option>
              ))}
            </select>
          )}
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
          <Outlet />
        </main>
      </div>
    </Ctx.Provider>
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
