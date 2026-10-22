import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { useApp } from '../components/Layout';
import { ErrorBanner, PlatformBadge, useLoad } from '../components/ui';
import { api } from '../lib/api';
import { dayKey, fmtTime, utcToZoned, zonedToUtc } from '../lib/time';
import type { Post } from '../lib/types';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function CalendarPage() {
  const { clients, tz: wsTz } = useApp();
  const nav = useNavigate();
  const [clientId, setClientId] = useState('');
  const tz = clients.find((c) => c.id === clientId)?.timezone ?? wsTz;
  const today = utcToZoned(new Date(), tz).date;
  const [cursor, setCursor] = useState(() => today.slice(0, 7));

  // Grid of 6 weeks starting on the Monday on or before the 1st.
  const days = useMemo(() => {
    const [y, m] = cursor.split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const start = new Date(first);
    start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setUTCDate(start.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
  }, [cursor]);

  const from = zonedToUtc(days[0], '00:00', tz).toISOString();
  const to = zonedToUtc(days[41], '23:59', tz).toISOString();
  const { data, error } = useLoad(() => api<{ posts: Post[] }>(`/posts?from=${from}&to=${to}${clientId ? `&client=${clientId}` : ''}`), [from, to, clientId]);

  const byDay = useMemo(() => {
    const map = new Map<string, Post[]>();
    for (const p of data?.posts ?? []) {
      if (!p.scheduledAt || p.status === 'cancelled') continue;
      const k = dayKey(p.scheduledAt, tz);
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    return map;
  }, [data, tz]);

  const shift = (n: number) => {
    const [y, m] = cursor.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setCursor(d.toISOString().slice(0, 7));
  };
  const title = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${cursor}-01T00:00:00Z`));
  const color = (id: string) => clients.find((c) => c.id === id)?.color ?? 'var(--tangerine)';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p>Times shown in {tz.replace(/_/g, ' ')}.</p>
        </div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Brand">
            <option value="">All brands</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn sm" onClick={() => shift(-1)} aria-label="Previous month">
              <ChevronLeft size={16} />
            </button>
            <button className="btn sm" onClick={() => setCursor(today.slice(0, 7))}>
              Today
            </button>
            <button className="btn sm" onClick={() => shift(1)} aria-label="Next month">
              <ChevronRight size={16} />
            </button>
          </div>
          <h2 style={{ minWidth: 170 }}>{title}</h2>
        </div>
      </div>
      <ErrorBanner error={error} />
      <div className="cal">
        {DOW.map((d) => (
          <div key={d} className="dow">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const posts = byDay.get(d) ?? [];
          return (
            <div
              key={d}
              className={`day ${d.slice(0, 7) !== cursor ? 'other' : ''} ${d === today ? 'today' : ''}`}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a')) return;
                if (d >= today) nav(`/posts/new?date=${d}${clientId ? `&client=${clientId}` : ''}`);
              }}
              title={d >= today ? 'Click to schedule a post on this day' : undefined}
            >
              <span className="num">{Number(d.slice(8))}</span>
              {posts.slice(0, 4).map((p) => (
                <Link key={p.id} to={`/posts/${p.id}`} className={`chip ${p.status}`} style={{ ['--client' as string]: color(p.clientId) }} title={p.body}>
                  <span className="t">{fmtTime(p.scheduledAt!, tz)}</span>
                  {[...new Set(p.targets.map((t) => t.platform))].slice(0, 3).map((pl) => (
                    <PlatformBadge key={pl} platform={pl} size={14} />
                  ))}
                  <span className="txt">{p.body.slice(0, 40) || '(image)'}</span>
                </Link>
              ))}
              {posts.length > 4 && <span className="more">+{posts.length - 4} more</span>}
            </div>
          );
        })}
      </div>
    </>
  );
}
