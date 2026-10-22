// Routes that need no sign-in: the client approval portal and shared reports (both
// unlocked by the client's secret link), public media for platforms that fetch images by
// URL, the cron wake-up, and the health check.
import { Hono } from 'hono';

import { HttpError, type Env } from '../auth.js';
import { config } from '../config.js';
import { all, one } from '../db.js';
import { decideApproval, postsJson } from '../engine/posts.js';
import { lastTick, tick } from '../engine/publisher.js';
import { proofReport } from './insights.js';
import { body } from './workspace.js';

async function clientByToken(t: string) {
  const client = await one<{ id: string; name: string; color: string; timezone: string; workspace_id: string }>('SELECT id, name, color, timezone, workspace_id FROM clients WHERE share_token = ? AND archived_at IS NULL', [t]);
  if (!client) throw new HttpError(404, 'This link is no longer valid. Ask your agency for a new one.');
  return client;
}

export const publicRoutes = new Hono<Env>()
  .get('/health', async (c) => {
    let db = false;
    try {
      await one('SELECT 1 AS ok');
      db = true;
    } catch {
      /* reported below */
    }
    const t = db ? await lastTick().catch(() => null) : null;
    return c.json({ ok: db, db, lastTickAt: t?.last_tick_at ?? null, version: '0.1.0' }, db ? 200 : 503);
  })
  // hPanel cron: curl -fsS "https://app.surecast.live/v1/cron/tick?key=CRON_SECRET"
  .on(['GET', 'POST'], '/cron/tick', async (c) => {
    const key = c.req.query('key') ?? c.req.header('X-Cron-Key') ?? '';
    if (!config.cronSecret || key !== config.cronSecret) throw new HttpError(403, 'Bad cron key.');
    const result = await tick('cron');
    return c.json({ ok: true, ...result });
  })

  .get('/public/portal/:token', async (c) => {
    const client = await clientByToken(c.req.param('token'));
    const ws = await one<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [client.workspace_id]);
    const pending = await all("SELECT * FROM posts WHERE client_id = ? AND approval_status IN ('pending', 'changes_requested') AND status NOT IN ('cancelled', 'failed') ORDER BY scheduled_at", [client.id]);
    const upcoming = await all("SELECT * FROM posts WHERE client_id = ? AND status = 'scheduled' AND scheduled_at > ? ORDER BY scheduled_at LIMIT 50", [client.id, new Date()]);
    const recent = await all("SELECT * FROM posts WHERE client_id = ? AND status IN ('published', 'partial') ORDER BY scheduled_at DESC LIMIT 20", [client.id]);
    const strip = (posts: Awaited<ReturnType<typeof postsJson>>) =>
      posts.map((p) => ({
        ...p,
        targets: p.targets.map((t) => ({ id: t.id, platform: t.platform, channelName: t.channelName, channelHandle: t.channelHandle, body: t.body, status: t.status, publishedAt: t.publishedAt, remoteUrl: t.remoteUrl })),
      }));
    return c.json({
      agency: ws?.name ?? '',
      client: { name: client.name, color: client.color, timezone: client.timezone },
      pending: strip(await postsJson(pending, { comments: true })),
      upcoming: strip(await postsJson(upcoming)),
      recent: strip(await postsJson(recent)),
    });
  })
  .post('/public/portal/:token/posts/:id/:decision', async (c) => {
    const client = await clientByToken(c.req.param('token'));
    const decision = c.req.param('decision');
    if (decision !== 'approve' && decision !== 'request-changes') throw new HttpError(404, 'Unknown action.');
    const b = await body(c);
    const comment = String(b.comment ?? '').trim();
    if (decision === 'request-changes' && !comment) throw new HttpError(422, 'Say what you would like changed.');
    await decideApproval(c.req.param('id'), client.id, decision === 'approve' ? 'approved' : 'changes_requested', String(b.name ?? '').trim(), comment);
    return c.json({ ok: true });
  })
  .get('/public/report/:token', async (c) => {
    const client = await clientByToken(c.req.param('token'));
    const report = await proofReport(client.id, c.req.query('month') ?? '');
    return c.json(report);
  });

/** Public images, served under /m/<key>. Instagram fetches post images from these URLs. */
export const mediaRoutes = new Hono().get('/m/:key', async (c) => {
  const m = await one<{ data: Buffer; mime: string }>('SELECT data, mime FROM media WHERE public_key = ?', [c.req.param('key')]);
  if (!m) return c.text('Not found', 404);
  return c.body(new Uint8Array(m.data), 200, { 'Content-Type': m.mime, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
});
