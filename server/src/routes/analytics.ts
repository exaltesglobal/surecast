// Analytics, best posting times, link tracking settings and link-in-bio pages.
import { Hono } from 'hono';

import { requireUser, type Env } from '../auth.js';
import { run } from '../db.js';
import { explainResults } from '../engine/ai.js';
import { analytics, analyticsCsv, bestTimes } from '../engine/analytics.js';
import { getBio, renderBio, saveBio } from '../engine/bio.js';
import { openLink, parseLinkSettings, shortBase } from '../engine/links.js';
import { getClient } from '../engine/posts.js';
import { body } from './workspace.js';

const range = (c: { req: { query: (k: string) => string | undefined } }) => ({ clientId: c.req.query('client') || undefined, days: Number(c.req.query('days')) || 30 });

export const analyticsRoutes = new Hono<Env>()
  .use('/analytics', requireUser)
  .use('/analytics/*', requireUser)
  .use('/clients/:id/best-times', requireUser)
  .use('/clients/:id/links', requireUser)
  .use('/clients/:id/bio', requireUser)
  .get('/analytics', async (c) => c.json(await analytics(c.get('workspaceId'), range(c))))
  .get('/analytics/export', async (c) => {
    const csv = await analyticsCsv(c.get('workspaceId'), range(c));
    return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="surecast-analytics.csv"' });
  })
  .post('/analytics/explain', async (c) => c.json(await explainResults(c.get('workspaceId'), await body(c))))
  .get('/clients/:id/best-times', async (c) => c.json(await bestTimes(c.get('workspaceId'), c.req.param('id'))))
  .get('/clients/:id/links', async (c) => {
    const client = await getClient(c.get('workspaceId'), c.req.param('id'));
    return c.json({ settings: parseLinkSettings(client.link_settings as string | null), shortBase: shortBase() });
  })
  .put('/clients/:id/links', async (c) => {
    const client = await getClient(c.get('workspaceId'), c.req.param('id'));
    const settings = parseLinkSettings(JSON.stringify(await body(c)));
    await run('UPDATE clients SET link_settings = ? WHERE id = ?', [JSON.stringify(settings), client.id]);
    return c.json({ settings, shortBase: shortBase() });
  })
  .get('/clients/:id/bio', async (c) => c.json({ page: await getBio(c.get('workspaceId'), c.req.param('id')) }))
  .put('/clients/:id/bio', async (c) => c.json({ page: await saveBio(c.get('workspaceId'), c.req.param('id'), await body(c)) }));

/** Public: short links and link-in-bio pages. Mounted at the site root. */
export const linkRoutes = new Hono()
  .get('/l/:code', async (c) => {
    const url = await openLink(c.req.param('code'), c.req.header('User-Agent') ?? '', c.req.header('Referer') ?? null);
    if (!url) return c.text('This link does not exist.', 404);
    c.header('Cache-Control', 'private, no-store');
    c.header('Referrer-Policy', 'unsafe-url');
    return c.redirect(url, 302);
  })
  .get('/b/:slug', async (c) => {
    const html = await renderBio(c.req.param('slug').toLowerCase());
    if (!html) return c.text('This page does not exist.', 404);
    return c.html(html, 200, { 'Cache-Control': 'public, max-age=60' });
  });
