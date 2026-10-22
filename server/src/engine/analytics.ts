// Analytics: what went out, how people responded, and when this audience responds best.
// Engagement is likes + comments + shares (reposts and quotes count as shares). Link clicks
// come from Surecast's own short links, so they are counted the same way on every network.
import { HttpError } from '../auth.js';
import { all, one } from '../db.js';
import { addMs } from '../util.js';

const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type TargetStat = {
  id: string;
  post_id: string;
  client_id: string;
  channel_id: string;
  platform: string;
  channel_name: string;
  published_at: Date;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  views: number | null;
  clicks: number;
  metrics_at: Date | null;
  remote_url: string | null;
  text: string;
};

const engagement = (t: Pick<TargetStat, 'likes' | 'comments' | 'shares'>) => (t.likes ?? 0) + (t.comments ?? 0) + (t.shares ?? 0);

async function targets(workspaceId: string, from: Date, to: Date, clientId?: string) {
  return all<TargetStat>(
    `SELECT t.id, t.post_id, p.client_id, t.channel_id, c.platform, c.name AS channel_name, t.published_at, t.likes, t.comments, t.shares, t.views, t.clicks, t.metrics_at, t.remote_url,
            COALESCE(t.body_override, p.body) AS text
     FROM post_targets t JOIN posts p ON p.id = t.post_id JOIN channels c ON c.id = t.channel_id
     WHERE t.workspace_id = ? AND t.status = 'published' AND t.published_at >= ? AND t.published_at < ? ${clientId ? 'AND p.client_id = ?' : ''}
     ORDER BY t.published_at`,
    clientId ? [workspaceId, from, to, clientId] : [workspaceId, from, to],
  );
}

/** Weekday (0 = Sunday) and hour of a moment in a time zone. */
export function localSlot(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const wd = parts.find((p) => p.type === 'weekday')!.value;
  return { day: WEEKDAYS.indexOf(wd), hour: Number(parts.find((p) => p.type === 'hour')!.value) % 24 };
}

const localDay = (d: Date, timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

function totals(rows: TargetStat[]) {
  const measured = rows.filter((r) => r.metrics_at);
  const eng = rows.reduce((n, r) => n + engagement(r), 0);
  return {
    posts: rows.length,
    engagement: eng,
    likes: rows.reduce((n, r) => n + (r.likes ?? 0), 0),
    comments: rows.reduce((n, r) => n + (r.comments ?? 0), 0),
    shares: rows.reduce((n, r) => n + (r.shares ?? 0), 0),
    views: rows.reduce((n, r) => n + (r.views ?? 0), 0),
    clicks: rows.reduce((n, r) => n + r.clicks, 0),
    perPost: measured.length ? Math.round((eng / measured.length) * 10) / 10 : null,
    measured: measured.length,
  };
}

/**
 * Scores each post against its own channel's average, so a big page doesn't drown out a small
 * one, then averages by weekday and hour. Needs at least 10 measured posts to say anything.
 */
export function rankSlots(rows: TargetStat[], timeZone: string) {
  const measured = rows.filter((r) => r.metrics_at);
  const avg = new Map<string, number>();
  for (const ch of new Set(measured.map((r) => r.channel_id))) {
    const mine = measured.filter((r) => r.channel_id === ch);
    avg.set(ch, mine.reduce((n, r) => n + engagement(r) + r.clicks, 0) / mine.length);
  }
  const cells = new Map<string, { day: number; hour: number; posts: number; score: number }>();
  for (const r of measured) {
    const { day, hour } = localSlot(r.published_at, timeZone);
    const key = `${day}:${hour}`;
    const cell = cells.get(key) ?? { day, hour, posts: 0, score: 0 };
    cell.posts++;
    cell.score += (engagement(r) + r.clicks + 1) / ((avg.get(r.channel_id) ?? 0) + 1);
    cells.set(key, cell);
  }
  return { measured: measured.length, cells: [...cells.values()].map((c) => ({ ...c, score: Math.round((c.score / c.posts) * 100) / 100 })) };
}

/** Widely observed good times, used until a client has enough of their own data. */
const GENERAL = [
  { day: 2, hour: 9 },
  { day: 3, hour: 12 },
  { day: 4, hour: 9 },
  { day: 1, hour: 11 },
  { day: 5, hour: 10 },
];

/** The best weekly posting times for a client, from their own results when there are enough. */
export async function bestTimes(workspaceId: string, clientId: string) {
  const client = await one<{ timezone: string }>('SELECT timezone FROM clients WHERE id = ? AND workspace_id = ?', [clientId, workspaceId]);
  if (!client) throw new HttpError(404, 'Brand not found.');
  const now = new Date();
  const rows = await targets(workspaceId, addMs(now, -90 * DAY), now, clientId);
  const { measured, cells } = rankSlots(rows, client.timezone);
  const fmt = (h: number) => `${String(h).padStart(2, '0')}:00`;
  if (measured < 10) {
    return { basis: 'general' as const, measured, timezone: client.timezone, slots: GENERAL.map((s) => ({ ...s, time: fmt(s.hour), score: null as number | null, posts: 0 })) };
  }
  const ranked = cells
    .filter((c) => c.posts >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  // Not enough repeated slots yet: fall back to single posts, best first.
  const slots = ranked.length >= 3 ? ranked : cells.sort((a, b) => b.score - a.score).slice(0, 5);
  return { basis: 'data' as const, measured, timezone: client.timezone, slots: slots.map((s) => ({ day: s.day, hour: s.hour, time: fmt(s.hour), score: s.score, posts: s.posts })) };
}

/** Everything the analytics page shows, for one client or the whole workspace. */
export async function analytics(workspaceId: string, opts: { clientId?: string; days: number }) {
  const days = Math.min(Math.max(Math.round(opts.days) || 30, 1), 365);
  let timezone = (await one<{ timezone: string }>('SELECT timezone FROM workspaces WHERE id = ?', [workspaceId]))?.timezone ?? 'UTC';
  if (opts.clientId) {
    const c = await one<{ timezone: string }>('SELECT timezone FROM clients WHERE id = ? AND workspace_id = ?', [opts.clientId, workspaceId]);
    if (!c) throw new HttpError(404, 'Brand not found.');
    timezone = c.timezone;
  }
  const now = new Date();
  const from = addMs(now, -days * DAY);
  const rows = await targets(workspaceId, from, now, opts.clientId);
  const before = await targets(workspaceId, addMs(from, -days * DAY), from, opts.clientId);

  const clickRows = await all<{ clicked_at: Date }>(
    `SELECT k.clicked_at FROM link_clicks k JOIN clients cl ON cl.id = k.client_id WHERE cl.workspace_id = ? AND k.clicked_at >= ? ${opts.clientId ? 'AND k.client_id = ?' : ''}`,
    opts.clientId ? [workspaceId, from, opts.clientId] : [workspaceId, from],
  );

  // One entry per day in the period, in the client's (or agency's) time zone.
  const daily = new Map<string, { date: string; posts: number; engagement: number; clicks: number }>();
  for (let d = days - 1; d >= 0; d--) {
    const date = localDay(addMs(now, -d * DAY), timezone);
    daily.set(date, { date, posts: 0, engagement: 0, clicks: 0 });
  }
  for (const r of rows) {
    const e = daily.get(localDay(r.published_at, timezone));
    if (e) {
      e.posts++;
      e.engagement += engagement(r);
    }
  }
  for (const k of clickRows) {
    const e = daily.get(localDay(k.clicked_at, timezone));
    if (e) e.clicks++;
  }

  const networks = [...new Set(rows.map((r) => r.platform))].map((platform) => ({ platform, ...totals(rows.filter((r) => r.platform === platform)) }));

  const top = [...rows]
    .sort((a, b) => engagement(b) + b.clicks - (engagement(a) + a.clicks))
    .slice(0, 10)
    .map((r) => ({
      targetId: r.id,
      postId: r.post_id,
      platform: r.platform,
      channelName: r.channel_name,
      publishedAt: r.published_at,
      url: r.remote_url,
      text: r.text.slice(0, 280),
      likes: r.likes,
      comments: r.comments,
      shares: r.shares,
      views: r.views,
      clicks: r.clicks,
      engagement: engagement(r),
    }));

  const { measured, cells } = rankSlots(rows, timezone);

  // Followers: the latest count for each channel and the change over the period.
  const channels = await all<{ id: string; name: string; platform: string; followers: number | null }>(
    `SELECT id, name, platform, followers FROM channels WHERE workspace_id = ? ${opts.clientId ? 'AND client_id = ?' : ''} ORDER BY platform, name`,
    opts.clientId ? [workspaceId, opts.clientId] : [workspaceId],
  );
  const history = channels.length
    ? await all<{ channel_id: string; day: Date | string; followers: number }>(
        `SELECT channel_id, day, followers FROM channel_stats WHERE channel_id IN (${channels.map(() => '?').join(',')}) AND day >= ? ORDER BY day`,
        [...channels.map((c) => c.id), localDay(addMs(from, -DAY), 'UTC')],
      )
    : [];
  const followers = channels
    .filter((c) => c.followers != null)
    .map((c) => {
      const series = history.filter((h) => h.channel_id === c.id).map((h) => ({ date: typeof h.day === 'string' ? h.day : h.day.toISOString().slice(0, 10), followers: h.followers }));
      return { channelId: c.id, name: c.name, platform: c.platform, followers: c.followers!, change: series.length ? c.followers! - series[0].followers : 0, series };
    });

  return {
    days,
    timezone,
    summary: { ...totals(rows), followers: followers.reduce((n, f) => n + f.followers, 0), followerChange: followers.reduce((n, f) => n + f.change, 0) },
    previous: totals(before),
    daily: [...daily.values()],
    networks,
    top,
    heatmap: { measured, cells },
    followers,
  };
}

/** One row per post-to-channel, for spreadsheets. */
export async function analyticsCsv(workspaceId: string, opts: { clientId?: string; days: number }) {
  const days = Math.min(Math.max(Math.round(opts.days) || 30, 1), 365);
  const now = new Date();
  const rows = await targets(workspaceId, addMs(now, -days * DAY), now, opts.clientId);
  const clients = new Map((await all<{ id: string; name: string }>('SELECT id, name FROM clients WHERE workspace_id = ?', [workspaceId])).map((c) => [c.id, c.name]));
  const cell = (v: unknown) => {
    const s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
    // Quote everything, and stop spreadsheet apps from running text that looks like a formula.
    return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const head = ['published_at', 'client', 'network', 'channel', 'text', 'likes', 'comments', 'shares', 'views', 'clicks', 'engagement', 'url'];
  const lines = rows.map((r) =>
    [r.published_at, clients.get(r.client_id), r.platform, r.channel_name, r.text, r.likes, r.comments, r.shares, r.views, r.clicks, engagement(r), r.remote_url].map(cell).join(','),
  );
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}
