import { ArrowDownRight, ArrowUpRight, Copy, Download, ExternalLink, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { useApp } from '../components/Layout';
import { Empty, ErrorBanner, Loading, PlatformBadge, Spinner, useLoad, useToast } from '../components/ui';
import { api, workspaceId } from '../lib/api';
import { platformInfo } from '../lib/platforms';
import { fmt } from '../lib/time';

type Totals = { posts: number; engagement: number; likes: number; comments: number; shares: number; views: number; clicks: number; perPost: number | null; measured: number };
type Data = {
  days: number;
  timezone: string;
  summary: Totals & { followers: number; followerChange: number };
  previous: Totals;
  daily: { date: string; posts: number; engagement: number; clicks: number }[];
  networks: (Totals & { platform: string })[];
  top: { targetId: string; postId: string; platform: string; channelName: string; publishedAt: string; url: string | null; text: string; likes: number | null; comments: number | null; shares: number | null; views: number | null; clicks: number; engagement: number }[];
  heatmap: { measured: number; cells: { day: number; hour: number; posts: number; score: number }[] };
  followers: { channelId: string; name: string; platform: string; followers: number; change: number; series: { date: string; followers: number }[] }[];
};
type Explained = { headline: string; wins: string[]; watch: string[]; next: string[] };

const n = (v: number) => v.toLocaleString();
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Change({ now, before }: { now: number; before: number }) {
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (!pct) return <span className="tiny muted">same as before</span>;
  const up = pct > 0;
  return (
    <span className="tiny" style={{ color: up ? 'var(--success)' : 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
      {Math.abs(pct)}% vs previous period
    </span>
  );
}

export function AnalyticsPage() {
  const { clients } = useApp();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const client = params.get('client') ?? '';
  const days = Number(params.get('days')) || 30;
  const q = `client=${client}&days=${days}`;
  const { data, error } = useLoad(() => api<Data>(`/analytics?${q}`), [q]);
  const [explained, setExplained] = useState<Explained | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setExplained(null);
  };

  const download = async () => {
    setBusy('csv');
    try {
      const ws = workspaceId.get();
      const res = await fetch(`/v1/analytics/export?${q}`, { headers: ws ? { 'X-Workspace-Id': ws } : {}, credentials: 'same-origin' });
      if (!res.ok) throw new Error('Export failed');
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `surecast-analytics-${days}d.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const explain = async () => {
    setBusy('ai');
    setAiError(null);
    try {
      setExplained(await api<Explained>('/analytics/explain', { body: { clientId: client || null, days } }));
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>How people responded to what went out. Numbers refresh from each network every hour for new posts.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={download} disabled={!!busy}>
            {busy === 'csv' ? <Spinner /> : <Download size={15} />} Export CSV
          </button>
          <button className="btn primary" onClick={explain} disabled={!!busy || !data?.summary.posts}>
            {busy === 'ai' ? <Spinner /> : <Sparkles size={15} />} Explain these results
          </button>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <select className="input" style={{ width: 'auto' }} value={client} onChange={(e) => set('client', e.target.value)} aria-label="Brand">
          <option value="">All brands</option>
          {clients
            .filter((c) => !c.archivedAt)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <div className="seg" role="group" aria-label="Period">
          {[7, 30, 90].map((d) => (
            <button key={d} className={d === days ? 'on' : ''} onClick={() => set('days', String(d))}>
              {d} days
            </button>
          ))}
        </div>
      </div>
      <ErrorBanner error={error ?? aiError} />
      {explained && <ExplainCard e={explained} />}
      {!data ? (
        !error && <Loading />
      ) : !data.summary.posts && !data.followers.length ? (
        <Empty title="Nothing published in this period yet">Once posts go out, their likes, comments, shares and link clicks show up here.</Empty>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid stats">
            <div className="card stat">
              <div className="label">Posts delivered</div>
              <div className="value">{n(data.summary.posts)}</div>
              <Change now={data.summary.posts} before={data.previous.posts} />
            </div>
            <div className="card stat">
              <div className="label">Likes, comments and shares</div>
              <div className="value">{n(data.summary.engagement)}</div>
              <Change now={data.summary.engagement} before={data.previous.engagement} />
            </div>
            <div className="card stat">
              <div className="label">Link clicks</div>
              <div className="value">{n(data.summary.clicks)}</div>
              <Change now={data.summary.clicks} before={data.previous.clicks} />
            </div>
            <div className="card stat">
              <div className="label">Followers</div>
              <div className="value">{n(data.summary.followers)}</div>
              {!!data.summary.followerChange && (
                <span className="tiny" style={{ color: data.summary.followerChange > 0 ? 'var(--success)' : 'var(--muted)' }}>
                  {data.summary.followerChange > 0 ? '+' : ''}
                  {n(data.summary.followerChange)} this period
                </span>
              )}
            </div>
          </div>

          <section className="card pad">
            <div className="row between" style={{ marginBottom: 8 }}>
              <h3>Engagement by day</h3>
              <span className="tiny muted">Counted on the day each post went out · {data.timezone.replace(/_/g, ' ')}</span>
            </div>
            <DailyChart daily={data.daily} />
          </section>

          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
            <section className="card">
              <div className="card-head">
                <h3>By network</h3>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Network</th>
                      <th className="num">Posts</th>
                      <th className="num">Likes</th>
                      <th className="num">Comments</th>
                      <th className="num">Shares</th>
                      <th className="num">Clicks</th>
                      <th className="num">Per post</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.networks.map((r) => (
                      <tr key={r.platform}>
                        <td>
                          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                            <PlatformBadge platform={r.platform} size={18} /> {platformInfo(r.platform).label}
                          </span>
                        </td>
                        <td className="num">{n(r.posts)}</td>
                        <td className="num">{r.measured ? n(r.likes) : '–'}</td>
                        <td className="num">{r.measured ? n(r.comments) : '–'}</td>
                        <td className="num">{r.measured ? n(r.shares) : '–'}</td>
                        <td className="num">{n(r.clicks)}</td>
                        <td className="num">{r.perPost ?? '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tiny muted" style={{ padding: '0 20px 14px' }}>
                – means the network doesn't share that number. Telegram doesn't report reactions to bots, and LinkedIn needs extra API access for them.
              </p>
            </section>

            <section className="card pad">
              <div className="row between" style={{ marginBottom: 8 }}>
                <h3>When this audience responds</h3>
                {client && (
                  <Link className="small" to={`/clients/${client}#posting-times`}>
                    Set posting times
                  </Link>
                )}
              </div>
              <Heatmap cells={data.heatmap.cells} measured={data.heatmap.measured} />
            </section>
          </div>

          <section className="card">
            <div className="card-head">
              <h3>Top posts</h3>
            </div>
            <div className="list">
              {data.top.map((t) => (
                <div key={t.targetId} className="list-item" style={{ alignItems: 'flex-start' }}>
                  <PlatformBadge platform={t.platform} size={22} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <Link to={`/posts/${t.postId}`} className="clamp small" style={{ color: 'var(--text)' }}>
                      {t.text || '(image only)'}
                    </Link>
                    <div className="tiny muted">
                      {t.channelName} · {fmt(t.publishedAt, data.timezone, { dateStyle: 'medium', timeStyle: 'short' })}
                    </div>
                  </div>
                  <div className="tiny" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <strong>{n(t.engagement)}</strong> engagement
                    <div className="muted">
                      {t.likes ?? 0} likes · {t.comments ?? 0} comments · {t.clicks} clicks
                    </div>
                  </div>
                  {t.url && (
                    <a href={t.url} target="_blank" rel="noreferrer" className="btn ghost sm" aria-label="Open the live post">
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </section>

          {!!data.followers.length && (
            <section className="card">
              <div className="card-head">
                <h3>Followers</h3>
              </div>
              <div className="list">
                {data.followers.map((f) => (
                  <div key={f.channelId} className="list-item" style={{ alignItems: 'center' }}>
                    <PlatformBadge platform={f.platform} size={22} />
                    <div className="grow">
                      <strong className="small">{f.name}</strong>
                      <div className="tiny muted">{platformInfo(f.platform).label}</div>
                    </div>
                    <Sparkline values={f.series.map((s) => s.followers)} />
                    <div style={{ textAlign: 'right', minWidth: 90 }}>
                      <strong>{n(f.followers)}</strong>
                      <div className="tiny" style={{ color: f.change > 0 ? 'var(--success)' : 'var(--muted)' }}>
                        {f.change > 0 ? '+' : ''}
                        {n(f.change)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function ExplainCard({ e }: { e: Explained }) {
  const toast = useToast();
  const text = [e.headline, '', 'What went well:', ...e.wins.map((w) => `• ${w}`), '', 'Worth watching:', ...e.watch.map((w) => `• ${w}`), '', 'Next steps:', ...e.next.map((w) => `• ${w}`)].join('\n');
  const block = (title: string, items: string[]) =>
    !!items.length && (
      <div>
        <strong className="small">{title}</strong>
        <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <section className="card pad stack" style={{ marginBottom: 16, borderColor: 'var(--accent)' }}>
      <div className="row between">
        <h3 className="row" style={{ gap: 6 }}>
          <Sparkles size={16} color="var(--accent)" /> {e.headline}
        </h3>
        <button
          className="btn sm"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            toast('Copied. Paste it into your brand report.');
          }}
        >
          <Copy size={14} /> Copy
        </button>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {block('What went well', e.wins)}
        {block('Worth watching', e.watch)}
        {block('Next steps', e.next)}
      </div>
    </section>
  );
}

/** One series (engagement per day) as thin bars, with a tooltip on hover or tap. */
function DailyChart({ daily }: { daily: Data['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 180;
  const pad = { l: 34, b: 22, t: 8 };
  const max = Math.max(1, ...daily.map((d) => d.engagement));
  const step = (W - pad.l) / daily.length;
  const bw = Math.max(2, Math.min(18, step - 2));
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.b - pad.t);
  const label = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const every = Math.ceil(daily.length / 8);
  const h = hover != null ? daily[hover] : null;
  return (
    <div style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Engagement per day" onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="var(--line)" strokeWidth={1} />
            <text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {daily.map((d, i) => {
          const x = pad.l + i * step + (step - bw) / 2;
          const top = y(d.engagement);
          const hgt = H - pad.b - top;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onClick={() => setHover(i)}>
              <rect x={pad.l + i * step} y={pad.t} width={step} height={H - pad.b - pad.t} fill="transparent" />
              {hgt > 0 && <path d={bar(x, top, bw, hgt)} fill="var(--accent)" opacity={hover == null || hover === i ? 1 : 0.45} />}
              {d.posts > 0 && hgt <= 0 && <circle cx={x + bw / 2} cy={H - pad.b - 3} r={2} fill="var(--muted)" />}
              {i % every === 0 && (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                  {label(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: `${((pad.l + hover! * step + step / 2) / W) * 100}%` }}>
          <strong>{label(h.date)}</strong>
          <div>
            {h.engagement} engagement · {h.posts} post{h.posts === 1 ? '' : 's'}
          </div>
          <div>{h.clicks} link clicks</div>
        </div>
      )}
    </div>
  );
}

/** A bar with rounded top corners, anchored square to the baseline. */
function bar(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function Heatmap({ cells, measured }: { cells: Data['heatmap']['cells']; measured: number }) {
  const [hover, setHover] = useState<string | null>(null);
  if (measured < 5) return <p className="small muted">This fills in once about 10 posts have numbers. Until then, the usual good times are weekday mornings around 9 to 11.</p>;
  const max = Math.max(...cells.map((c) => c.score));
  const at = (d: number, h: number) => cells.find((c) => c.day === d && c.hour === h);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const hc = hover ? cells.find((c) => `${c.day}:${c.hour}` === hover) : null;
  return (
    <div>
      <div className="heat" role="table" aria-label="Average response by weekday and hour">
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className="tiny muted heat-h">
            {h % 6 === 0 ? h : ''}
          </span>
        ))}
        {order.map((d) => (
          <div key={d} role="row" style={{ display: 'contents' }}>
            <span className="tiny muted">{DAYS[d]}</span>
            {Array.from({ length: 24 }, (_, h) => {
              const c = at(d, h);
              // Sequential: one hue, more opaque for a stronger response.
              const level = c ? 0.18 + 0.82 * (c.score / max) : 0;
              return (
                <span
                  key={h}
                  role="cell"
                  className="heat-cell"
                  style={{ background: c ? `color-mix(in srgb, var(--accent) ${Math.round(level * 100)}%, var(--surface-2))` : 'var(--surface-2)' }}
                  onMouseEnter={() => setHover(c ? `${d}:${h}` : null)}
                  onMouseLeave={() => setHover(null)}
                  aria-label={c ? `${DAYS[d]} ${h}:00, ${c.posts} posts, ${c.score} times the usual response` : undefined}
                />
              );
            })}
          </div>
        ))}
      </div>
      <p className="tiny muted" style={{ marginTop: 8, minHeight: 18 }}>
        {hc
          ? `${DAYS[hc.day]} ${String(hc.hour).padStart(2, '0')}:00 · ${hc.posts} post${hc.posts === 1 ? '' : 's'} · ${hc.score}× the channel's usual response`
          : `Darker means a stronger response than usual for that channel. Based on ${measured} posts.`}
      </p>
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span style={{ width: 90 }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 88 + 1},${max === min ? 14 : 26 - ((v - min) / (max - min)) * 24}`).join(' ');
  return (
    <svg width={90} height={28} aria-hidden>
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
