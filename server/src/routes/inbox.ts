// The unified inbox.
import { Hono } from 'hono';

import { requireUser, type Env } from '../auth.js';
import { suggestReplies } from '../engine/ai.js';
import { collectInbox, listInbox, replyToItem, setStatus } from '../engine/inbox.js';
import { body } from './workspace.js';

export const inboxRoutes = new Hono<Env>()
  .use('/inbox', requireUser)
  .use('/inbox/*', requireUser)
  .get('/inbox', async (c) =>
    c.json(
      await listInbox(c.get('workspaceId'), {
        clientId: c.req.query('client') || undefined,
        status: c.req.query('status') || 'open',
        platform: c.req.query('platform') || undefined,
        before: c.req.query('before') || undefined,
        limit: Number(c.req.query('limit')) || 50,
      }),
    ),
  )
  .post('/inbox/refresh', async (c) => c.json({ found: await collectInbox() }))
  .post('/inbox/status', async (c) => {
    const b = await body(c);
    const ids = Array.isArray(b.ids) ? b.ids.filter((x: unknown): x is string => typeof x === 'string') : [];
    return c.json({ updated: await setStatus(c.get('workspaceId'), ids, String(b.status ?? '')) });
  })
  .post('/inbox/:id/reply', async (c) => c.json({ item: await replyToItem(c.get('workspaceId'), c.get('user'), c.req.param('id'), (await body(c)).text) }))
  .post('/inbox/:id/suggest', async (c) => c.json(await suggestReplies(c.get('workspaceId'), c.req.param('id'))));
