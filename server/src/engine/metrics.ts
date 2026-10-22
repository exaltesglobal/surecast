// Engagement numbers (likes, comments, shares, views) for published posts, and daily follower
// counts per channel. Numbers are read back from each network on a slowing schedule: hourly
// while a post is fresh, then every 6 hours for a week, then daily until it is 30 days old.
import { all, run } from '../db.js';
import { adapter, PublishError } from '../platforms/index.js';
import { addMs, minutes } from '../util.js';
import { channelCtx, type ChannelRow } from './channels.js';

const HOUR = minutes(60);
const DAY = 24 * HOUR;
const BATCH = 200;

/** Refreshes engagement numbers for posts that are due. Returns how many posts were updated. */
export async function collectMetrics(now = new Date()) {
  const due = await all<{ id: string; channel_id: string; remote_id: string }>(
    `SELECT t.id, t.channel_id, t.remote_id FROM post_targets t JOIN channels c ON c.id = t.channel_id
     WHERE t.status = 'published' AND t.remote_id IS NOT NULL AND t.remote_id <> '' AND t.published_at >= ? AND c.status <> 'disconnected'
       AND (t.metrics_at IS NULL OR t.metrics_at < CASE WHEN t.published_at >= ? THEN ? WHEN t.published_at >= ? THEN ? ELSE ? END)
     ORDER BY t.metrics_at IS NULL DESC, t.metrics_at LIMIT ${BATCH}`,
    [addMs(now, -30 * DAY), addMs(now, -DAY), addMs(now, -HOUR), addMs(now, -7 * DAY), addMs(now, -6 * HOUR), addMs(now, -DAY)],
  );
  const byChannel = new Map<string, typeof due>();
  for (const d of due) byChannel.set(d.channel_id, [...(byChannel.get(d.channel_id) ?? []), d]);
  let updated = 0;
  for (const [channelId, targets] of byChannel) {
    const ch = (await all<ChannelRow>('SELECT * FROM channels WHERE id = ?', [channelId]))[0];
    if (!ch) continue;
    const a = adapter(ch.platform);
    let numbers: Awaited<ReturnType<NonNullable<typeof a.metrics>>> = {};
    if (a.metrics) {
      try {
        numbers = await a.metrics(channelCtx(ch), targets.map((t) => t.remote_id));
      } catch (e) {
        // Numbers are a nice-to-have: a failure here never touches the channel's health. Try again next round.
        if (!(e instanceof PublishError)) console.error(`Reading metrics for channel ${channelId} failed`, e);
        continue;
      }
    }
    for (const t of targets) {
      const m = numbers[t.remote_id];
      if (m) {
        await run('UPDATE post_targets SET likes = ?, comments = ?, shares = ?, views = ?, metrics_at = ? WHERE id = ?', [m.likes, m.comments, m.shares, m.views, now, t.id]);
        updated++;
      } else {
        // Network without numbers, or the post was deleted: don't ask again until the next window.
        await run('UPDATE post_targets SET metrics_at = ? WHERE id = ?', [now, t.id]);
      }
    }
  }
  return updated;
}

/** Records follower counts about twice a day per channel, keeping one row per day for trends. */
export async function collectFollowers(now = new Date()) {
  const channels = await all<ChannelRow>("SELECT * FROM channels WHERE status <> 'disconnected' AND (followers_at IS NULL OR followers_at < ?) LIMIT 50", [addMs(now, -12 * HOUR)]);
  for (const ch of channels) {
    const a = adapter(ch.platform);
    let n: number | null = null;
    if (a.followers) {
      try {
        n = await a.followers(channelCtx(ch));
      } catch (e) {
        if (!(e instanceof PublishError)) console.error(`Reading followers for channel ${ch.id} failed`, e);
      }
    }
    await run('UPDATE channels SET followers = COALESCE(?, followers), followers_at = ? WHERE id = ?', [n, now, ch.id]);
    if (n != null)
      await run('INSERT INTO channel_stats (channel_id, day, followers) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE followers = VALUES(followers)', [ch.id, now.toISOString().slice(0, 10), n]);
  }
}

/** Runs both collectors at most every 5 minutes per process; the queries decide what is due. */
let lastRun = 0;
export async function collectStats(now = new Date(), force = false) {
  if (!force && Date.now() - lastRun < minutes(5)) return;
  lastRun = Date.now();
  await collectMetrics(now);
  await collectFollowers(now);
}
