// Google Drive as the workspace's media store.
import { Hono } from 'hono';

import { HttpError, requireAdmin, requireUser, type Env } from '../auth.js';
import { disconnectDrive, driveAvailable, driveJson, finishDrive, getDrive, startDrive } from '../engine/drive.js';

export const driveRoutes = new Hono<Env>()
  // Google sends the browser back here. Mounted before the channel OAuth callback, which would otherwise take it.
  .get('/oauth/gdrive/callback', async (c) => {
    const q = c.req.query();
    if (q.error || !q.code || !q.state) return c.redirect(`/settings?driveError=${encodeURIComponent(q.error_description || q.error || 'Connection was cancelled.')}#drive`);
    try {
      await finishDrive(q.state, q.code);
      return c.redirect('/settings?drive=connected#drive');
    } catch (e) {
      return c.redirect(`/settings?driveError=${encodeURIComponent((e as Error).message)}#drive`);
    }
  })
  .get('/integrations/google-drive', requireUser, async (c) => c.json({ available: driveAvailable(), drive: driveJson(await getDrive(c.get('workspaceId'))) }))
  .post('/integrations/google-drive', requireUser, requireAdmin, async (c) => c.json({ redirect: await startDrive(c.get('workspaceId'), c.get('user')!.id) }))
  .delete('/integrations/google-drive', requireUser, requireAdmin, async (c) => {
    const r = await disconnectDrive(c.get('workspaceId'));
    if (!r) throw new HttpError(404, 'Google Drive is not connected.');
    return c.json(r);
  });
