// The health dashboard, alerts, and proof-of-publish reports.
import { Hono } from 'hono';

import { HttpError, requireUser, type Env } from '../auth.js';
import { all, one, run } from '../db.js';
import { lastTick } from '../engine/publisher.js';
import { monthRange } from '../util.js';

/** Every post-to-channel in a month for one client, with when it went out and its live link. */
export async function proofReport(clientId: string, month: string) {
  const client = await one<{ id: string; name: string; timezone: string; color: string; workspace_id: string }>('SELECT id, name, timezone, color, workspace_id FROM clients WHERE id = ?', [clientId]);
  if (!client) throw new HttpError(404, 'Client not found.');
  const ws = await one<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [client.workspace_id]);
  const range = monthRange(month, client.timezone);
  const rows = await all(
    `SELECT t.id, t.status, t.due_at, t.published_at, t.remote_url, t.attempts, t.error_code, t.error_message, COALESCE(t.body_override, p.body) AS text,
            c.platform, c.name AS channel_name, c.handle AS channel_handle
     FROM post_targets t JOIN posts p ON p.id = t.post_id LEFT JOIN channels c ON c.id = t.channel_id
     WHERE p.client_id = ? AND t.status IN ('published', 'failed') AND COALESCE(t.published_at, t.due_at) >= ? AND COALESCE(t.published_at, t.due_at) < ?
     ORDER BY COALESCE(t.published_at, t.due_at)`,
    [clientId, range.from, range.to],
  );
  const items = rows.map((r) => {
    const delayMin = r.published_at && r.due_at ? Math.max(0, Math.round((r.published_at.getTime() - r.due_at.getTime()) / 60_000)) : null;
    return {
      id: r.id,
      status: r.status,
      platform: r.platform,
      channelName: r.channel_name,
      channelHandle: r.channel_handle,
      scheduledAt: r.due_at,
      publishedAt: r.published_at,
      delayMinutes: delayMin,
      url: r.remote_url,
      attempts: r.attempts,
      text: String(r.text ?? '').slice(0, 280),
      error: r.error_code ? r.error_message : null,
    };
  });
  const published = items.filter((i) => i.status === 'published');
  const onTime = published.filter((i) => (i.delayMinutes ?? 0) <= 5);
  return {
    agency: ws?.name ?? '',
    client: { id: client.id, name: client.name, timezone: client.timezone, color: client.color },
    month: range.label,
    summary: {
      total: items.length,
      published: published.length,
      failed: items.length - published.length,
      onTime: onTime.length,
      successRate: items.length ? Math.round((published.length / items.length) * 1000) / 10 : null,
      retried: published.filter((i) => i.attempts > 1).length,
    },
    items,
    generatedAt: new Date(),
  };
}

export const insightRoutes = new Hono<Env>()
  .use(requireUser)
  .get('/dashboard', async (c) => {
    const ws = c.get('workspaceId');
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const dayAhead = new Date(now.getTime() + 86_400_000);
    const count = async (sql: string, params: unknown[]) => Number((await one<{ n: number }>(sql, params))?.n ?? 0);
    const [published24h, failed24h, upcoming24h, retrying, awaitingApproval, scheduledTotal] = await Promise.all([
      count("SELECT COUNT(*) AS n FROM post_targets WHERE workspace_id = ? AND status = 'published' AND published_at >= ?", [ws, dayAgo]),
      count("SELECT COUNT(*) AS n FROM post_targets WHERE workspace_id = ? AND status = 'failed' AND updated_at >= ?", [ws, dayAgo]),
      count("SELECT COUNT(*) AS n FROM post_targets WHERE workspace_id = ? AND status IN ('scheduled', 'awaiting_approval') AND due_at < ?", [ws, dayAhead]),
      count("SELECT COUNT(*) AS n FROM post_targets WHERE workspace_id = ? AND status = 'retrying'", [ws]),
      count("SELECT COUNT(*) AS n FROM posts WHERE workspace_id = ? AND status IN ('awaiting_approval', 'changes_requested')", [ws]),
      count("SELECT COUNT(*) AS n FROM post_targets WHERE workspace_id = ? AND status = 'scheduled'", [ws]),
    ]);
    const month = new Date(now.getTime() - 30 * 86_400_000);
    const rate = await one<{ ok: number; total: number }>(
      "SELECT SUM(status = 'published') AS ok, COUNT(*) AS total FROM post_targets WHERE workspace_id = ? AND status IN ('published', 'failed') AND updated_at >= ?",
      [ws, month],
    );
    const channels = await all(
      `SELECT ch.id, ch.platform, ch.name, ch.handle, ch.avatar_url AS avatarUrl, ch.status, ch.status_detail AS statusDetail, ch.token_expires_at AS tokenExpiresAt, ch.last_ok_at AS lastOkAt,
              cl.id AS clientId, cl.name AS clientName, cl.color AS clientColor,
              (SELECT COUNT(*) FROM post_targets t WHERE t.channel_id = ch.id AND t.status IN ('scheduled', 'retrying', 'awaiting_approval')) AS queued
       FROM channels ch JOIN clients cl ON cl.id = ch.client_id WHERE ch.workspace_id = ? ORDER BY FIELD(ch.status, 'disconnected', 'failing', 'expiring', 'ok'), cl.name`,
      [ws],
    );
    const alerts = await all('SELECT * FROM alerts WHERE workspace_id = ? AND resolved_at IS NULL ORDER BY FIELD(severity, \'error\', \'warning\', \'info\'), created_at DESC LIMIT 20', [ws]);
    const tick = await lastTick();
    return c.json({
      stats: {
        published24h,
        failed24h,
        upcoming24h,
        retrying,
        awaitingApproval,
        scheduledTotal,
        successRate30d: rate && Number(rate.total) ? Math.round((Number(rate.ok) / Number(rate.total)) * 1000) / 10 : null,
      },
      channels: channels.map((ch) => ({ ...ch, queued: Number(ch.queued) })),
      alerts: alerts.map(alertJson),
      scheduler: { lastTickAt: tick?.last_tick_at ?? null, source: tick?.last_source ?? null, healthy: !!tick && now.getTime() - tick.last_tick_at.getTime() < 3 * 60_000 },
    });
  })
  .get('/alerts', async (c) => {
    const open = c.req.query('all') !== '1';
    const rows = await all(`SELECT * FROM alerts WHERE workspace_id = ?${open ? ' AND resolved_at IS NULL' : ''} ORDER BY resolved_at IS NULL DESC, created_at DESC LIMIT 200`, [c.get('workspaceId')]);
    return c.json({ alerts: rows.map(alertJson) });
  })
  .post('/alerts/:id/resolve', async (c) => {
    await run('UPDATE alerts SET resolved_at = ? WHERE id = ? AND workspace_id = ? AND resolved_at IS NULL', [new Date(), c.req.param('id'), c.get('workspaceId')]);
    return c.json({ ok: true });
  })
  .get('/reports/proof', async (c) => {
    const clientId = c.req.query('client') ?? '';
    const own = await one('SELECT id FROM clients WHERE id = ? AND workspace_id = ?', [clientId, c.get('workspaceId')]);
    if (!own) throw new HttpError(404, 'Client not found.');
    return c.json(await proofReport(clientId, c.req.query('month') ?? ''));
  });

export const alertJson = (a: Record<string, any>) => ({
  id: a.id,
  kind: a.kind,
  severity: a.severity,
  title: a.title,
  detail: a.detail,
  clientId: a.client_id,
  channelId: a.channel_id,
  postId: a.post_id,
  createdAt: a.created_at,
  resolvedAt: a.resolved_at,
  emailedAt: a.emailed_at,
});
