// The weekly client digest: every Monday morning in the client's own time zone, the client's
// contact gets a short email of what went out last week, how it did, and what is coming up.
// The agency looks busy and on top of things without writing a report.
import { config } from '../config.js';
import { all, run } from '../db.js';
import { emailHtml, sendEmail } from '../mail.js';
import { adapter } from '../platforms/index.js';
import { addMs, tzOffsetMs } from '../util.js';

const DAY = 86_400_000;
const SEND_HOUR = 9;

type DigestClient = { id: string; workspace_id: string; name: string; timezone: string; contact_email: string; share_token: string; digest_sent_at: Date | null };

const label = (platform: string) => {
  try {
    return adapter(platform).label;
  } catch {
    return platform;
  }
};

/** The digest for one client, as plain lines. Exported for the preview in the app. */
export async function digestFor(c: Pick<DigestClient, 'id' | 'name' | 'timezone' | 'share_token'>, now = new Date()) {
  const since = addMs(now, -7 * DAY);
  const published = await all<{ platform: string; text: string; likes: number | null; comments: number | null; shares: number | null; clicks: number; url: string | null }>(
    `SELECT ch.platform, LEFT(COALESCE(t.body_override, p.body), 140) AS text, t.likes, t.comments, t.shares, t.clicks, t.remote_url AS url
     FROM post_targets t JOIN posts p ON p.id = t.post_id JOIN channels ch ON ch.id = t.channel_id
     WHERE p.client_id = ? AND t.status = 'published' AND t.published_at >= ? AND t.published_at < ?`,
    [c.id, since, now],
  );
  const upcoming = await all<{ scheduled_at: Date; text: string }>(
    "SELECT scheduled_at, LEFT(body, 100) AS text FROM posts WHERE client_id = ? AND status IN ('scheduled', 'awaiting_approval') AND scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at LIMIT 20",
    [c.id, now, addMs(now, 7 * DAY)],
  );
  const waiting = await all('SELECT id FROM posts WHERE client_id = ? AND approval_status = ? AND status <> ?', [c.id, 'pending', 'cancelled']);
  const engagement = published.reduce((s, t) => s + (t.likes ?? 0) + (t.comments ?? 0) + (t.shares ?? 0), 0);
  const clicks = published.reduce((s, t) => s + (t.clicks ?? 0), 0);
  const networks = [...new Set(published.map((t) => label(t.platform)))];
  const top = [...published].sort((a, b) => (b.likes ?? 0) + (b.comments ?? 0) + (b.shares ?? 0) - ((a.likes ?? 0) + (a.comments ?? 0) + (a.shares ?? 0)))[0];
  const when = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: c.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
  const lines = [
    published.length
      ? `Last week ${published.length} post${published.length === 1 ? '' : 's'} went out${networks.length ? ` on ${networks.join(', ')}` : ''}, with ${engagement} likes, comments and shares${clicks ? ` and ${clicks} link clicks` : ''}.`
      : 'Nothing was published last week.',
  ];
  if (top && (top.likes ?? 0) + (top.comments ?? 0) + (top.shares ?? 0) > 0) lines.push(`Best post (${label(top.platform)}): "${top.text.trim()}"`);
  lines.push(
    upcoming.length
      ? `Coming up this week:\n${upcoming
          .slice(0, 7)
          .map((u) => `• ${when(u.scheduled_at)}: ${u.text.trim().split('\n')[0]}`)
          .join('\n')}${upcoming.length > 7 ? `\n…and ${upcoming.length - 7} more` : ''}`
      : 'Nothing is scheduled for the coming week yet.',
  );
  if (waiting.length) lines.push(`${waiting.length} post${waiting.length === 1 ? ' is' : 's are'} waiting for your approval.`);
  return { subject: `${c.name}: your week on social media`, lines, url: `${config.publicUrl}/c/${c.share_token}`, counts: { published: published.length, upcoming: upcoming.length, waiting: waiting.length, engagement, clicks } };
}

/** Sends due digests: Monday from 09:00 in the client's time zone, once a week. */
export async function sendDigests(now = new Date()) {
  const clients = await all<DigestClient>(
    'SELECT id, workspace_id, name, timezone, contact_email, share_token, digest_sent_at FROM clients WHERE digest_enabled = 1 AND contact_email IS NOT NULL AND archived_at IS NULL AND (digest_sent_at IS NULL OR digest_sent_at < ?)',
    [addMs(now, -6 * DAY)],
  );
  let sent = 0;
  for (const c of clients) {
    const local = new Date(now.getTime() + tzOffsetMs(now.getTime(), c.timezone));
    if (local.getUTCDay() !== 1 || local.getUTCHours() < SEND_HOUR) continue;
    // Take the slot first, so two ticks never send twice.
    const took = await run('UPDATE clients SET digest_sent_at = ? WHERE id = ? AND (digest_sent_at IS NULL OR digest_sent_at < ?)', [now, c.id, addMs(now, -6 * DAY)]);
    if (!took) continue;
    const d = await digestFor(c, now);
    try {
      await sendEmail(c.contact_email, d.subject, `${d.lines.join('\n\n')}\n\nSee everything: ${d.url}`, emailHtml(d.subject, d.lines, { label: 'See your posts', url: d.url }));
      sent++;
    } catch (e) {
      await run('UPDATE clients SET digest_sent_at = ? WHERE id = ?', [c.digest_sent_at, c.id]);
      console.error(`Digest for ${c.id} failed; will retry`, e);
    }
  }
  return sent;
}
