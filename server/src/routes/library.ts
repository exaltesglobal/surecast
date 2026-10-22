// Saved snippets and hashtag groups, posting queues, RSS feeds and CSV import.
import { Hono } from 'hono';

import { HttpError, requireUser, type Env } from '../auth.js';
import { all, json, one, run } from '../db.js';
import { checkFeed, feedJson, getFeed, loadFeed } from '../engine/feeds.js';
import { previewImport, runImport } from '../engine/importer.js';
import { getClient } from '../engine/posts.js';
import { cleanSlots, nextQueueSlot } from '../engine/queue.js';
import { newId } from '../util.js';
import { body } from './workspace.js';

const MODES = ['queue', 'draft', 'now'];

async function feedChannels(clientId: string, v: unknown) {
  const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  if (!ids.length) throw new HttpError(422, 'Choose at least one channel for new articles.');
  const owned = await all<{ id: string }>('SELECT id FROM channels WHERE id IN (?) AND client_id = ?', [ids, clientId]);
  if (owned.length !== new Set(ids).size) throw new HttpError(422, 'Some channels do not belong to this client.');
  return [...new Set(ids)];
}

export const libraryRoutes = new Hono<Env>()
  .use('/snippets/*', requireUser)
  .use('/snippets', requireUser)
  .use('/feeds/*', requireUser)
  .use('/feeds', requireUser)
  .use('/import/*', requireUser)
  .use('/clients/:id/queue', requireUser)

  // Snippets: hashtag groups, signatures, disclaimers.
  .get('/snippets', async (c) => {
    const rows = await all('SELECT id, client_id AS clientId, name, body FROM snippets WHERE workspace_id = ? ORDER BY name', [c.get('workspaceId')]);
    return c.json({ snippets: rows });
  })
  .post('/snippets', async (c) => {
    const b = await body(c);
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '';
    const text = typeof b.body === 'string' ? b.body.trim().slice(0, 5000) : '';
    if (!name || !text) throw new HttpError(422, 'Give the snippet a name and some text.');
    if (b.clientId) await getClient(c.get('workspaceId'), b.clientId);
    const id = newId('snp');
    await run('INSERT INTO snippets (id, workspace_id, client_id, name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, c.get('workspaceId'), b.clientId || null, name, text, new Date()]);
    return c.json({ id }, 201);
  })
  .delete('/snippets/:id', async (c) => {
    if (!(await run('DELETE FROM snippets WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]))) throw new HttpError(404, 'Snippet not found.');
    return c.json({ ok: true });
  })

  // Posting times for "Add to queue".
  .get('/clients/:id/queue', async (c) => {
    const client = await getClient(c.get('workspaceId'), c.req.param('id'));
    const slots = cleanSlots(json(client.queue_slots, []));
    const upcoming = await all<{ id: string; body: string; scheduled_at: Date; status: string }>(
      "SELECT id, body, scheduled_at, status FROM posts WHERE client_id = ? AND scheduled_at >= ? AND status NOT IN ('cancelled', 'failed', 'draft') ORDER BY scheduled_at LIMIT 50",
      [client.id, new Date()],
    );
    let next: Date | null = null;
    if (slots.length) next = await nextQueueSlot(client).catch(() => null);
    return c.json({ slots, next, upcoming: upcoming.map((p) => ({ id: p.id, body: p.body, scheduledAt: p.scheduled_at, status: p.status })) });
  })
  .put('/clients/:id/queue', async (c) => {
    const client = await getClient(c.get('workspaceId'), c.req.param('id'));
    const slots = cleanSlots((await body(c)).slots);
    await run('UPDATE clients SET queue_slots = ? WHERE id = ?', [JSON.stringify(slots), client.id]);
    return c.json({ slots });
  })

  // RSS feeds.
  .get('/feeds', async (c) => {
    const q = c.req.query('client');
    const rows = await all(`SELECT * FROM feeds WHERE workspace_id = ?${q ? ' AND client_id = ?' : ''} ORDER BY created_at`, [c.get('workspaceId'), ...(q ? [q] : [])]);
    return c.json({ feeds: rows.map(feedJson) });
  })
  .post('/feeds/preview', async (c) => {
    const feed = await loadFeed(String((await body(c)).url ?? '').trim());
    return c.json({ title: feed.title, items: feed.items.slice(0, 5) });
  })
  .post('/feeds', async (c) => {
    const b = await body(c);
    const client = await getClient(c.get('workspaceId'), b.clientId);
    const url = String(b.url ?? '').trim();
    const feed = await loadFeed(url);
    const mode = MODES.includes(b.mode) ? b.mode : 'queue';
    const template = typeof b.template === 'string' && b.template.trim() ? b.template.slice(0, 2000) : '{title}\n\n{link}';
    const id = newId('fed');
    await run('INSERT INTO feeds (id, workspace_id, client_id, url, title, channel_ids, template, mode, seen, last_checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      c.get('workspaceId'),
      client.id,
      url.slice(0, 1000),
      feed.title.slice(0, 255),
      JSON.stringify(await feedChannels(client.id, b.channelIds)),
      template,
      mode,
      // What is already in the feed counts as seen: only new articles become posts.
      JSON.stringify(feed.items.map((i) => i.id).slice(0, 500)),
      new Date(),
      new Date(),
    ]);
    return c.json({ id }, 201);
  })
  .patch('/feeds/:id', async (c) => {
    const f = await getFeed(c.get('workspaceId'), c.req.param('id'));
    const b = await body(c);
    await run('UPDATE feeds SET channel_ids = ?, template = ?, mode = ?, active = ? WHERE id = ?', [
      b.channelIds !== undefined ? JSON.stringify(await feedChannels(f.client_id, b.channelIds)) : f.channel_ids,
      typeof b.template === 'string' && b.template.trim() ? b.template.slice(0, 2000) : f.template,
      MODES.includes(b.mode) ? b.mode : f.mode,
      typeof b.active === 'boolean' ? (b.active ? 1 : 0) : f.active,
      f.id,
    ]);
    return c.json({ ok: true });
  })
  .post('/feeds/:id/check', async (c) => {
    const f = await getFeed(c.get('workspaceId'), c.req.param('id'));
    const r = await checkFeed(f);
    const after = await one('SELECT * FROM feeds WHERE id = ?', [f.id]);
    return c.json({ created: r.created, feed: feedJson(after!) });
  })
  .delete('/feeds/:id', async (c) => {
    const f = await getFeed(c.get('workspaceId'), c.req.param('id'));
    await run('DELETE FROM feeds WHERE id = ?', [f.id]);
    return c.json({ ok: true });
  })

  // CSV import: preview first, then save.
  .post('/import/preview', async (c) => {
    const b = await body(c);
    return c.json(await previewImport(c.get('workspaceId'), b.clientId, b.csv));
  })
  .post('/import/run', async (c) => {
    const b = await body(c);
    return c.json(await runImport(c.get('workspaceId'), c.get('user'), b.clientId, b.csv));
  });
