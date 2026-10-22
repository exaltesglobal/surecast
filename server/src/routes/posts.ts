// Posts and the media library.
import { Hono } from 'hono';

import { HttpError, requireUser, type Env } from '../auth.js';
import { all, json, one, run } from '../db.js';
import { MAX_UPLOAD, mediaUrl, storeMedia } from '../engine/content.js';
import { retryFollowUps } from '../engine/followups.js';
import { cancelPost, postsJson, retryPost, savePost, validateDraft } from '../engine/posts.js';
import { newId } from '../util.js';
import { body } from './workspace.js';

export const postRoutes = new Hono<Env>()
  .use(requireUser)
  .get('/posts', async (c) => {
    const q = c.req.query();
    const where = ['p.workspace_id = ?'];
    const params: unknown[] = [c.get('workspaceId')];
    if (q.client) {
      where.push('p.client_id = ?');
      params.push(q.client);
    }
    if (q.status) {
      where.push('p.status IN (?)');
      params.push(q.status.split(','));
    }
    if (q.from) {
      where.push('p.scheduled_at >= ?');
      params.push(new Date(q.from));
    }
    if (q.to) {
      where.push('p.scheduled_at < ?');
      params.push(new Date(q.to));
    }
    if (q.unscheduled === '1') where.push('p.scheduled_at IS NULL');
    const limit = Math.min(Number(q.limit) || 500, 1000);
    const order = q.order === 'desc' ? 'DESC' : 'ASC';
    const rows = await all(`SELECT p.* FROM posts p WHERE ${where.join(' AND ')} ORDER BY p.scheduled_at IS NULL, p.scheduled_at ${order}, p.created_at DESC LIMIT ${limit}`, params);
    return c.json({ posts: await postsJson(rows) });
  })
  .get('/posts/:id', async (c) => {
    const row = await one('SELECT * FROM posts WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    if (!row) throw new HttpError(404, 'Post not found.');
    const [post] = await postsJson([row], { attempts: true, comments: true });
    return c.json({ post });
  })
  .post('/posts/validate', async (c) => c.json({ channels: await validateDraft(c.get('workspaceId'), await body(c)) }))
  .post('/posts', async (c) => {
    const id = await savePost(c.get('workspaceId'), c.get('user'), await body(c), undefined, c.get('viaApiKey') ? 'api' : 'app');
    const [post] = await postsJson([await one('SELECT * FROM posts WHERE id = ?', [id])].filter(Boolean) as any[]);
    return c.json({ post }, 201);
  })
  .patch('/posts/:id', async (c) => {
    const id = await savePost(c.get('workspaceId'), c.get('user'), await body(c), c.req.param('id'));
    const [post] = await postsJson([await one('SELECT * FROM posts WHERE id = ?', [id])].filter(Boolean) as any[]);
    return c.json({ post });
  })
  .post('/posts/:id/retry', async (c) => {
    await retryPost(c.get('workspaceId'), c.req.param('id'), (await body(c)).targetId);
    return c.json({ ok: true });
  })
  .post('/posts/:id/retry-followups', async (c) => {
    if (!(await retryFollowUps(c.get('workspaceId'), c.req.param('id')))) throw new HttpError(409, 'Nothing to retry: every thread part and comment has gone out.');
    return c.json({ ok: true });
  })
  .post('/posts/:id/cancel', async (c) => {
    await cancelPost(c.get('workspaceId'), c.req.param('id'));
    return c.json({ ok: true });
  })
  .post('/posts/:id/duplicate', async (c) => {
    const p = await one('SELECT * FROM posts WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    if (!p) throw new HttpError(404, 'Post not found.');
    const targets = await all('SELECT channel_id, body_override FROM post_targets WHERE post_id = ?', [p.id]);
    const id = await savePost(c.get('workspaceId'), c.get('user'), {
      clientId: p.client_id,
      body: p.body,
      mediaIds: json(p.media_ids, []),
      channelIds: targets.map((t) => t.channel_id),
      overrides: Object.fromEntries(targets.filter((t) => t.body_override != null).map((t) => [t.channel_id, t.body_override])),
      thread: json(p.thread, []),
      firstComment: p.first_comment,
      action: 'draft',
    });
    return c.json({ id }, 201);
  })
  .delete('/posts/:id', async (c) => {
    const busy = await one("SELECT id FROM post_targets WHERE post_id = ? AND status IN ('published', 'publishing')", [c.req.param('id')]);
    if (busy) throw new HttpError(409, 'This post has already gone out on some channels, so it is kept for your records. Cancel it instead.');
    const n = await run('DELETE FROM posts WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    if (!n) throw new HttpError(404, 'Post not found.');
    await run('DELETE FROM post_targets WHERE post_id = ?', [c.req.param('id')]);
    await run('DELETE FROM post_comments WHERE post_id = ?', [c.req.param('id')]);
    return c.json({ ok: true });
  })
  .post('/posts/:id/comments', async (c) => {
    const text = String((await body(c)).body ?? '').trim();
    if (!text) throw new HttpError(422, 'Write a comment first.');
    const p = await one('SELECT id FROM posts WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    if (!p) throw new HttpError(404, 'Post not found.');
    const u = c.get('user')!;
    await run("INSERT INTO post_comments (id, post_id, author_name, from_client, kind, body, created_at) VALUES (?, ?, ?, 0, 'comment', ?, ?)", [newId('cmt'), p.id, u.name || u.email, text.slice(0, 5000), new Date()]);
    return c.json({ ok: true }, 201);
  })

  // Media library
  .get('/media', async (c) => {
    const rows = await all('SELECT id, filename, mime, size, alt, public_key, created_at FROM media WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200', [c.get('workspaceId')]);
    return c.json({ media: rows.map((m) => ({ id: m.id, filename: m.filename, mime: m.mime, size: m.size, alt: m.alt ?? '', url: mediaUrl(m.public_key), createdAt: m.created_at })) });
  })
  .post('/media', async (c) => {
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(422, 'Choose an image to upload.');
    if (file.size > MAX_UPLOAD) throw new HttpError(413, 'Images can be up to 10 MB.');
    const buf = Buffer.from(await file.arrayBuffer());
    const alt = typeof form.alt === 'string' ? form.alt.slice(0, 2000) : '';
    const { id, filename, mime, key } = await storeMedia(c.get('workspaceId'), buf, file.name, alt);
    return c.json({ media: { id, filename, mime, size: buf.length, alt, url: mediaUrl(key) } }, 201);
  })
  .patch('/media/:id', async (c) => {
    const alt = String((await body(c)).alt ?? '').slice(0, 2000);
    await run('UPDATE media SET alt = ? WHERE id = ? AND workspace_id = ?', [alt, c.req.param('id'), c.get('workspaceId')]);
    return c.json({ ok: true });
  })
  .delete('/media/:id', async (c) => {
    const used = await one(
      "SELECT p.id FROM posts p WHERE p.workspace_id = ? AND p.media_ids LIKE ? AND p.status IN ('draft', 'awaiting_approval', 'changes_requested', 'scheduled', 'publishing')",
      [c.get('workspaceId'), `%"${c.req.param('id')}"%`],
    );
    if (used) throw new HttpError(409, 'This image is used by a post that has not gone out yet.');
    await run('DELETE FROM media WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    return c.json({ ok: true });
  });
