// The emergency brake, brand safety guard, Chitthi (WhatsApp), moments calendar, campaigns from
// a link and the weekly client digest.
import { Hono } from 'hono';

import { HttpError, requireAdmin, requireUser, type Env } from '../auth.js';
import { all, one } from '../db.js';
import { campaignFromUrl } from '../engine/ai.js';
import { pauseClient, resumeClient } from '../engine/brake.js';
import { connectChitthi, disconnectChitthi, getIntegration, integrationJson, receiveHook, testChitthi, updateChitthiSettings } from '../engine/chitthi.js';
import { digestFor } from '../engine/digest.js';
import { cleanGuard, guardIssues, parseGuard } from '../engine/guard.js';
import { addMoment, deleteMoment, listMoments } from '../engine/moments.js';
import { emailHtml, sendEmail } from '../mail.js';
import { body } from './workspace.js';

export const agencyRoutes = new Hono<Env>()
  // Emergency brake
  .post('/clients/:id/pause', requireUser, async (c) => {
    const b = await body(c);
    const user = c.get('user')!;
    return c.json(await pauseClient(c.get('workspaceId'), c.req.param('id'), { reason: b.reason, until: b.until, missed: b.missed, by: user.name || user.email }, user));
  })
  .post('/clients/:id/resume', requireUser, async (c) => c.json(await resumeClient(c.get('workspaceId'), c.req.param('id'), (await body(c)).missed, c.get('user'))))

  // Brand safety guard: check any text against a client's rules (also used by the composer as you type).
  .post('/guard/check', requireUser, async (c) => {
    const b = await body(c);
    const client = await one<{ guard: string | null }>('SELECT guard FROM clients WHERE id = ? AND workspace_id = ?', [String(b.clientId ?? ''), c.get('workspaceId')]);
    if (!client) throw new HttpError(404, 'Client not found.');
    const guard = b.guard !== undefined ? cleanGuard(b.guard) : parseGuard(client.guard);
    const issues = guardIssues(guard, typeof b.text === 'string' ? b.text : '');
    return c.json({ ok: !issues.length, mode: guard.mode, issues });
  })

  // Weekly client digest
  .get('/clients/:id/digest', requireUser, async (c) => {
    const client = await one('SELECT id, name, timezone, share_token FROM clients WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    if (!client) throw new HttpError(404, 'Client not found.');
    return c.json(await digestFor(client as never));
  })
  .post('/clients/:id/digest/test', requireUser, async (c) => {
    const client = await one('SELECT id, name, timezone, share_token FROM clients WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    if (!client) throw new HttpError(404, 'Client not found.');
    const d = await digestFor(client as never);
    const to = c.get('user')!.email;
    await sendEmail(to, `[Preview] ${d.subject}`, `${d.lines.join('\n\n')}\n\nSee everything: ${d.url}`, emailHtml(d.subject, d.lines, { label: 'See your posts', url: d.url }));
    return c.json({ sentTo: to });
  })

  // Chitthi (WhatsApp)
  .get('/integrations/chitthi', requireUser, async (c) => {
    const ws = c.get('workspaceId');
    const clients = await all('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ? AND client_id IS NOT NULL', [ws, 'chitthi']);
    return c.json({ agency: integrationJson(await getIntegration(ws, null)), clients: clients.map((r) => integrationJson(r as never)) });
  })
  .post('/integrations/chitthi', requireUser, requireAdmin, async (c) => {
    const b = await body(c);
    return c.json({ integration: await connectChitthi(c.get('workspaceId'), typeof b.clientId === 'string' && b.clientId ? b.clientId : null, b.apiKey, b.settings) }, 201);
  })
  .patch('/integrations/chitthi', requireUser, requireAdmin, async (c) => c.json({ integration: await updateChitthiSettings(c.get('workspaceId'), (await body(c)).settings) }))
  .post('/integrations/chitthi/test', requireUser, requireAdmin, async (c) => c.json(await testChitthi(c.get('workspaceId'))))
  .delete('/integrations/chitthi', requireUser, requireAdmin, async (c) => {
    const removed = await disconnectChitthi(c.get('workspaceId'), c.req.query('client') || null);
    if (!removed) throw new HttpError(404, 'Chitthi is not connected.');
    return c.json({ ok: true });
  })

  // Moments calendar
  .get('/moments', requireUser, async (c) =>
    c.json(await listMoments(c.get('workspaceId'), { from: c.req.query('from'), to: c.req.query('to'), regions: c.req.query('regions'), clientId: c.req.query('client') })),
  )
  .post('/moments', requireUser, async (c) => c.json({ id: await addMoment(c.get('workspaceId'), await body(c)) }, 201))
  .delete('/moments/:id', requireUser, async (c) => {
    await deleteMoment(c.get('workspaceId'), c.req.param('id'));
    return c.json({ ok: true });
  })

  // A whole campaign from one link
  .post('/ai/campaign', requireUser, async (c) => c.json(await campaignFromUrl(c.get('workspaceId'), c.get('user'), await body(c))));

// Chitthi calls this with each new WhatsApp message. It is signed, and has no session, so it is
// mounted before the routes that require one.
export const hookRoutes = new Hono<Env>().post('/hooks/chitthi/:token', async (c) =>
  c.json(await receiveHook(c.req.param('token'), await c.req.text(), c.req.header('Chitthi-Signature'))),
);
