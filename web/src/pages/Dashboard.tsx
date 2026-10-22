import { Activity, AlertTriangle, CheckCircle2, PlugZap, Users } from 'lucide-react';
import { Link } from 'react-router';

import { useApp } from '../components/Layout';
import { Avatar, Empty, ErrorBanner, Loading, Pill, useLoad } from '../components/ui';
import { api } from '../lib/api';
import { platformInfo } from '../lib/platforms';
import { ago, fmt } from '../lib/time';
import type { Alert } from '../lib/types';

type Dash = {
  stats: { published24h: number; failed24h: number; upcoming24h: number; retrying: number; awaitingApproval: number; scheduledTotal: number; successRate30d: number | null };
  channels: { id: string; platform: string; name: string; handle: string; avatarUrl: string | null; status: string; statusDetail: string | null; tokenExpiresAt: string | null; lastOkAt: string | null; clientId: string; clientName: string; clientColor: string; queued: number }[];
  alerts: Alert[];
  scheduler: { lastTickAt: string | null; source: string | null; healthy: boolean };
};

export function Dashboard() {
  const { clients } = useApp();
  const { data, error, loading } = useLoad(() => api<Dash>('/dashboard'));
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBanner error={error} />;
  const { stats, channels, alerts, scheduler } = data;
  const atRisk = channels.filter((c) => c.status !== 'ok');

  if (!clients.length)
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Welcome to Surecast</h1>
            <p>Three steps and your first post is on its way.</p>
          </div>
        </div>
        <div className="grid three">
          {[
            { n: 1, icon: <Users />, title: 'Add a brand', text: 'Each brand gets its own channels, time zone and approval settings.', to: '/clients?new=1', cta: 'Add brand' },
            { n: 2, icon: <PlugZap />, title: 'Connect channels', text: 'Bluesky, Mastodon and Telegram work straight away. More networks switch on as their apps are approved.', to: '/clients', cta: 'Connect' },
            { n: 3, icon: <CheckCircle2 />, title: 'Schedule a post', text: 'Write once, adjust per network, and Surecast makes sure it goes out.', to: '/posts/new', cta: 'Write a post' },
          ].map((s) => (
            <div key={s.n} className="card pad stack">
              <div style={{ color: 'var(--accent)' }}>{s.icon}</div>
              <h3>
                {s.n}. {s.title}
              </h3>
              <p className="muted">{s.text}</p>
              <Link to={s.to} className="btn" style={{ alignSelf: 'flex-start' }}>
                {s.cta}
              </Link>
            </div>
          ))}
        </div>
      </>
    );

  const healthy = !alerts.some((a) => a.severity === 'error') && !atRisk.some((c) => c.status === 'disconnected') && scheduler.healthy;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Health</h1>
          <p>Everything that's going out, and anything that needs you.</p>
        </div>
        <Link to="/posts/new" className="btn primary">
          New post
        </Link>
      </div>

      <div className={`banner ${healthy ? 'success' : 'error'}`} style={{ marginBottom: 16 }}>
        {healthy ? <CheckCircle2 size={20} /> : <AlertTriangle size={20} />}
        <div className="body">
          <strong>{healthy ? 'All clear. Every channel is healthy and posts are going out.' : 'Some things need your attention.'}</strong>
          <p>
            <Activity size={13} style={{ verticalAlign: -2 }} /> Scheduler {scheduler.healthy ? 'running' : 'has not run recently'} · last check {ago(scheduler.lastTickAt)}
            {!scheduler.healthy && '. If this persists, check the cron job in hPanel.'}
          </p>
        </div>
      </div>

      <div className="grid stats" style={{ marginBottom: 20 }}>
        <Stat label="Posted (24h)" value={stats.published24h} tone="good" />
        <Stat label="Failed (24h)" value={stats.failed24h} tone={stats.failed24h ? 'bad' : undefined} />
        <Stat label="Going out next 24h" value={stats.upcoming24h} />
        <Stat label="Retrying now" value={stats.retrying} />
        <Stat label="Awaiting approval" value={stats.awaitingApproval} />
        <Stat label="Success rate (30d)" value={stats.successRate30d == null ? '–' : `${stats.successRate30d}%`} />
      </div>

      <div className="grid two">
        <section className="card">
          <div className="card-head">
            <h2>Needs attention</h2>
            <Link to="/alerts" className="small">
              All alerts
            </Link>
          </div>
          {alerts.length ? (
            <div className="list">
              {alerts.map((a) => (
                <Link key={a.id} to={a.postId ? `/posts/${a.postId}` : a.channelId && a.clientId ? `/clients/${a.clientId}` : '/alerts'} className="list-item" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <AlertTriangle size={18} color={a.severity === 'error' ? 'var(--error)' : 'var(--warning)'} style={{ flex: 'none', marginTop: 2 }} />
                  <div className="grow">
                    <strong>{a.title}</strong>
                    {a.detail && <p className="muted small clamp">{a.detail}</p>}
                    <span className="tiny muted">{ago(a.createdAt)}</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <Empty title="Nothing needs you" icon={<CheckCircle2 size={28} />}>
              Failures, expiring connections and reviewer change requests show up here.
            </Empty>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Channel health</h2>
            <span className="small muted">
              {channels.length - atRisk.length} of {channels.length} healthy
            </span>
          </div>
          {channels.length ? (
            <div className="list">
              {channels.map((c) => (
                <Link key={c.id} to={`/clients/${c.clientId}`} className="list-item" style={{ color: 'inherit', textDecoration: 'none', alignItems: 'center' }}>
                  <Avatar src={c.avatarUrl} name={c.name} platform={c.platform} />
                  <div className="grow">
                    <div className="row" style={{ gap: 6 }}>
                      <strong>{c.name}</strong>
                      <span className="small muted">{platformInfo(c.platform).label}</span>
                    </div>
                    <div className="tiny muted row" style={{ gap: 6 }}>
                      <span className="client-dot" style={{ background: c.clientColor }} /> {c.clientName} · {c.queued} queued
                      {c.tokenExpiresAt && ` · expires ${fmt(c.tokenExpiresAt, undefined, { dateStyle: 'medium' })}`}
                    </div>
                    {c.statusDetail && c.status !== 'ok' && <div className="tiny" style={{ color: c.status === 'disconnected' ? 'var(--error)' : 'var(--warning)' }}>{c.statusDetail}</div>}
                  </div>
                  <Pill status={c.status} />
                </Link>
              ))}
            </div>
          ) : (
            <Empty title="No channels yet">
              <Link to="/clients">Connect a channel</Link> to start posting.
            </Empty>
          )}
        </section>
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`card stat ${tone ?? ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
