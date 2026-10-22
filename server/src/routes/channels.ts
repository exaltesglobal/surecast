// Connecting, checking and removing channels.
import { Hono } from 'hono';

import { HttpError, requireUser, type Env } from '../auth.js';
import { config } from '../config.js';
import { all, json, one, run } from '../db.js';
import { resolveAlerts } from '../engine/alerts.js';
import { checkChannel, getChannel } from '../engine/channels.js';
import { rollupPost } from '../engine/publisher.js';
import { adapter, adapters, PublishError, type Candidate } from '../platforms/index.js';
import { addMs, decrypt, encrypt, minutes, newId, token } from '../util.js';
import { body } from './workspace.js';

const redirectUri = (platform: string) => `${config.publicUrl}/v1/oauth/${platform === 'instagram' ? 'facebook' : platform}/callback`;

/** Adds a channel, or updates it if this account is already connected for the client (a reconnect). */
async function saveChannel(workspaceId: string, clientId: string, cand: Candidate) {
  const now = new Date();
  const existing = await one<{ id: string }>('SELECT id FROM channels WHERE client_id = ? AND platform = ? AND external_id = ?', [clientId, cand.platform, cand.externalId]);
  if (existing) {
    await run(
      "UPDATE channels SET name = ?, handle = ?, avatar_url = ?, credentials = ?, token_expires_at = ?, status = 'ok', status_detail = NULL, last_checked_at = ?, last_ok_at = ?, consecutive_failures = 0 WHERE id = ?",
      [cand.name, cand.handle, cand.avatarUrl, encrypt(cand.credentials), cand.tokenExpiresAt, now, now, existing.id],
    );
    await resolveAlerts(workspaceId, [`channel:${existing.id}:disconnected`, `channel:${existing.id}:failing`, `channel:${existing.id}:expiring`]);
    // Posts that were waiting for this channel go out now.
    const waiting = await all<{ id: string; post_id: string }>("SELECT id, post_id FROM post_targets WHERE channel_id = ? AND status = 'retrying'", [existing.id]);
    await run("UPDATE post_targets SET next_attempt_at = ?, updated_at = ? WHERE channel_id = ? AND status = 'retrying'", [now, now, existing.id]);
    await resolveAlerts(workspaceId, waiting.map((w) => `target:${w.id}:waiting`));
    for (const w of waiting) await rollupPost(w.post_id);
    return { id: existing.id, reconnected: true };
  }
  const id = newId('chn');
  await run(
    'INSERT INTO channels (id, workspace_id, client_id, platform, name, handle, external_id, avatar_url, credentials, status, token_expires_at, last_checked_at, last_ok_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, workspaceId, clientId, cand.platform, cand.name, cand.handle, cand.externalId, cand.avatarUrl, encrypt(cand.credentials), 'ok', cand.tokenExpiresAt, now, now, now],
  );
  return { id, reconnected: false };
}

const channelJson = (r: Record<string, any>) => ({
  id: r.id,
  clientId: r.client_id,
  platform: r.platform,
  name: r.name,
  handle: r.handle,
  avatarUrl: r.avatar_url,
  status: r.status,
  statusDetail: r.status_detail,
  tokenExpiresAt: r.token_expires_at,
  lastCheckedAt: r.last_checked_at,
  lastOkAt: r.last_ok_at,
  createdAt: r.created_at,
});

export const channelRoutes = new Hono<Env>()
  .get('/platforms', (c) =>
    c.json({
      platforms: adapters().map((a) => ({
        platform: a.platform,
        label: a.label,
        available: a.available(),
        unavailableReason: a.available() ? null : a.unavailableReason,
        limits: a.limits,
        connect: { kind: a.connect.kind, help: a.connect.help, fields: a.connect.fields ?? [] },
      })),
    }),
  )

  // OAuth providers redirect the browser here; the session cookie identifies the person.
  .get('/oauth/:platform/callback', async (c) => {
    const q = c.req.query();
    const state = q.state ? await one<{ workspace_id: string; client_id: string; user_id: string; platform: string; data: string; expires_at: Date }>('SELECT * FROM oauth_states WHERE state = ?', [q.state]) : null;
    if (!state || state.expires_at < new Date()) return c.redirect('/channels?error=' + encodeURIComponent('That connection link expired. Try connecting again.'));
    await run('DELETE FROM oauth_states WHERE state = ?', [q.state]);
    const back = `/clients/${state.client_id}`;
    if (q.error || !q.code) return c.redirect(`${back}?error=${encodeURIComponent(q.error_description || q.error || 'Connection was cancelled.')}`);
    try {
      const a = adapter(state.platform);
      if (a.connect.kind !== 'oauth') throw new Error('Not an OAuth platform');
      const candidates = await a.connect.finish({ code: q.code, redirectUri: redirectUri(state.platform), data: json(state.data, {}) });
      if (candidates.length === 1) {
        const saved = await saveChannel(state.workspace_id, state.client_id, candidates[0]);
        return c.redirect(`${back}?connected=${saved.id}`);
      }
      const id = newId('pnd');
      await run('INSERT INTO pending_connections (id, workspace_id, client_id, platform, candidates, expires_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id,
        state.workspace_id,
        state.client_id,
        state.platform,
        encrypt(candidates),
        addMs(new Date(), minutes(30)),
      ]);
      return c.redirect(`/connect/${id}`);
    } catch (e) {
      const msg = e instanceof PublishError ? `${e.message}. ${e.hint}` : (e as Error).message;
      return c.redirect(`${back}?error=${encodeURIComponent(msg)}`);
    }
  })

  .use(requireUser)
  .get('/channels', async (c) => {
    const clientId = c.req.query('client');
    const rows = await all(`SELECT * FROM channels WHERE workspace_id = ?${clientId ? ' AND client_id = ?' : ''} ORDER BY created_at`, [c.get('workspaceId'), ...(clientId ? [clientId] : [])]);
    return c.json({ channels: rows.map(channelJson) });
  })
  .post('/channels/connect', async (c) => {
    const b = await body(c);
    const client = await one<{ id: string }>('SELECT id FROM clients WHERE id = ? AND workspace_id = ?', [b.clientId, c.get('workspaceId')]);
    if (!client) throw new HttpError(404, 'Brand not found.');
    const a = adapter(String(b.platform));
    if (!a.available()) throw new HttpError(409, a.unavailableReason ?? `${a.label} is not available yet.`);
    const values = (b.values && typeof b.values === 'object' ? b.values : {}) as Record<string, string>;
    for (const f of a.connect.fields ?? []) if (f.required && !String(values[f.name] ?? '').trim()) throw new HttpError(422, `${f.label} is required.`);
    try {
      if (a.connect.kind === 'fields') {
        const profile = await a.connect.submit(values);
        const saved = await saveChannel(c.get('workspaceId'), client.id, { ...profile, platform: a.platform });
        return c.json({ channelId: saved.id, reconnected: saved.reconnected });
      }
      const state = token(24);
      const started = await a.connect.start({ state, redirectUri: redirectUri(a.platform), values });
      await run('INSERT INTO oauth_states (state, workspace_id, client_id, user_id, platform, data, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        state,
        c.get('workspaceId'),
        client.id,
        c.get('user')!.id,
        a.platform,
        JSON.stringify(started.data ?? {}),
        addMs(new Date(), minutes(20)),
      ]);
      return c.json({ redirect: started.url });
    } catch (e) {
      if (e instanceof PublishError) throw new HttpError(422, `${e.message}. ${e.hint}`);
      throw e;
    }
  })
  .get('/pending/:id', async (c) => {
    const p = await one<{ candidates: string; client_id: string; platform: string }>('SELECT * FROM pending_connections WHERE id = ? AND workspace_id = ? AND expires_at > ?', [c.req.param('id'), c.get('workspaceId'), new Date()]);
    if (!p) throw new HttpError(404, 'This connection has expired. Connect again.');
    const cands = decrypt<Candidate[]>(p.candidates);
    return c.json({ clientId: p.client_id, candidates: cands.map((x, i) => ({ index: i, platform: x.platform, name: x.name, handle: x.handle, avatarUrl: x.avatarUrl, detail: x.detail ?? null })) });
  })
  .post('/pending/:id', async (c) => {
    const p = await one<{ candidates: string; client_id: string }>('SELECT * FROM pending_connections WHERE id = ? AND workspace_id = ? AND expires_at > ?', [c.req.param('id'), c.get('workspaceId'), new Date()]);
    if (!p) throw new HttpError(404, 'This connection has expired. Connect again.');
    const cands = decrypt<Candidate[]>(p.candidates);
    const picked = ((await body(c)).indexes ?? []) as number[];
    if (!Array.isArray(picked) || !picked.length) throw new HttpError(422, 'Pick at least one account.');
    const ids = [];
    for (const i of picked) if (cands[i]) ids.push((await saveChannel(c.get('workspaceId'), p.client_id, cands[i])).id);
    await run('DELETE FROM pending_connections WHERE id = ?', [c.req.param('id')]);
    return c.json({ channelIds: ids, clientId: p.client_id });
  })
  .post('/channels/:id/check', async (c) => {
    const ch = await getChannel(c.req.param('id'));
    if (!ch || ch.workspace_id !== c.get('workspaceId')) throw new HttpError(404, 'Channel not found.');
    const result = await checkChannel(ch);
    const fresh = await getChannel(ch.id);
    return c.json({ ...result, channel: channelJson(fresh!) });
  })
  .delete('/channels/:id', async (c) => {
    const ch = await getChannel(c.req.param('id'));
    if (!ch || ch.workspace_id !== c.get('workspaceId')) throw new HttpError(404, 'Channel not found.');
    const affected = await all<{ post_id: string }>("SELECT DISTINCT post_id FROM post_targets WHERE channel_id = ? AND status NOT IN ('published', 'failed', 'cancelled')", [ch.id]);
    await run("UPDATE post_targets SET status = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE channel_id = ? AND status NOT IN ('published', 'failed', 'cancelled', 'publishing')", [new Date(), ch.id]);
    await run('DELETE FROM channels WHERE id = ?', [ch.id]);
    await run('UPDATE alerts SET resolved_at = ? WHERE channel_id = ? AND resolved_at IS NULL', [new Date(), ch.id]);
    for (const a of affected) await rollupPost(a.post_id);
    return c.json({ ok: true, cancelledPosts: affected.length });
  });
