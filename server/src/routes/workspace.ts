// Account, workspace settings, team, clients, API keys and webhooks.
import { Hono } from 'hono';

import { generateApiKey, HttpError, logout, requestCode, requireAdmin, requireUser, verifyCode, type Env } from '../auth.js';
import { config } from '../config.js';
import { all, one, run } from '../db.js';
import { cleanVoice, parseVoice } from '../engine/ai.js';
import { emitEvent } from '../engine/webhooks.js';
import { emailHtml, sendEmail } from '../mail.js';
import { hashSecret, isEmail, isTimeZone, newId, token } from '../util.js';

export const body = async (c: { req: { json: () => Promise<any> } }): Promise<Record<string, any>> => {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === 'object' ? b : {};
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const accountRoutes = new Hono<Env>()
  .post('/auth/code', async (c) => {
    await requestCode((await body(c)).email);
    return c.json({ ok: true });
  })
  .post('/auth/verify', async (c) => {
    const b = await body(c);
    const user = await verifyCode(c, b.email, b.code, b.name);
    return c.json({ user });
  })
  .post('/auth/logout', async (c) => {
    await logout(c);
    return c.json({ ok: true });
  })
  .get('/me', async (c) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'Sign in to continue.');
    const workspaces = await all('SELECT w.id, w.name, w.timezone, m.role FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY m.created_at', [user.id]);
    return c.json({ user, workspaces, workspaceId: c.get('workspaceId') ?? null });
  })
  .patch('/me', requireUser, async (c) => {
    const name = str((await body(c)).name, 120);
    await run('UPDATE users SET name = ? WHERE id = ?', [name, c.get('user')!.id]);
    return c.json({ ok: true });
  });

export const workspaceRoutes = new Hono<Env>()
  .use(requireUser)
  .get('/workspace', async (c) => {
    const ws = await one('SELECT id, name, timezone, alert_emails FROM workspaces WHERE id = ?', [c.get('workspaceId')]);
    return c.json({ workspace: { ...ws, alertEmails: ws?.alert_emails ?? '' }, role: c.get('role') });
  })
  .patch('/workspace', requireAdmin, async (c) => {
    const b = await body(c);
    if (b.timezone !== undefined && !isTimeZone(b.timezone)) throw new HttpError(422, 'Unknown time zone.');
    const emails = typeof b.alertEmails === 'string' ? b.alertEmails.split(/[,\s]+/).filter(Boolean) : null;
    if (emails?.some((e: string) => !isEmail(e))) throw new HttpError(422, 'One of the alert emails is not valid.');
    await run('UPDATE workspaces SET name = COALESCE(NULLIF(?, \'\'), name), timezone = COALESCE(?, timezone), alert_emails = COALESCE(?, alert_emails) WHERE id = ?', [
      str(b.name, 120),
      b.timezone ?? null,
      emails ? emails.join(', ') : null,
      c.get('workspaceId'),
    ]);
    return c.json({ ok: true });
  })

  // Team
  .get('/members', async (c) => {
    const members = await all('SELECT u.id, u.email, u.name, m.role, m.created_at AS joinedAt FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at', [c.get('workspaceId')]);
    return c.json({ members });
  })
  .post('/members', requireAdmin, async (c) => {
    const b = await body(c);
    if (!isEmail(b.email)) throw new HttpError(422, 'Enter a valid email address.');
    const role = b.role === 'admin' ? 'admin' : 'editor';
    const email = b.email.trim().toLowerCase();
    let user = await one<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
    if (!user) {
      user = { id: newId('usr') };
      await run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', [user.id, email, str(b.name, 120), new Date()]);
    }
    const added = await run('INSERT IGNORE INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', [c.get('workspaceId'), user.id, role, new Date()]);
    if (!added) throw new HttpError(409, 'That person is already in this workspace.');
    const ws = await one<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [c.get('workspaceId')]);
    const inviter = c.get('user')!.name || c.get('user')!.email;
    await sendEmail(
      email,
      `${inviter} added you to ${ws?.name} on Surecast`,
      `${inviter} added you to ${ws?.name} on Surecast.\n\nSign in with this email address: ${config.publicUrl}/login`,
      emailHtml(`You have been added to ${ws?.name}`, [`${inviter} added you to ${ws?.name} on Surecast. Sign in with this email address.`], { label: 'Sign in', url: `${config.publicUrl}/login` }),
    ).catch((e) => console.error('Invite email failed', e));
    return c.json({ ok: true });
  })
  .patch('/members/:userId', requireAdmin, async (c) => {
    const role = (await body(c)).role;
    if (!['owner', 'admin', 'editor'].includes(role)) throw new HttpError(422, 'Unknown role.');
    if (role === 'owner' && c.get('role') !== 'owner') throw new HttpError(403, 'Only an owner can make someone an owner.');
    await run('UPDATE members SET role = ? WHERE workspace_id = ? AND user_id = ?', [role, c.get('workspaceId'), c.req.param('userId')]);
    return c.json({ ok: true });
  })
  .delete('/members/:userId', requireAdmin, async (c) => {
    const owners = await all("SELECT user_id FROM members WHERE workspace_id = ? AND role = 'owner'", [c.get('workspaceId')]);
    if (owners.length === 1 && owners[0].user_id === c.req.param('userId')) throw new HttpError(409, 'A workspace needs at least one owner.');
    await run('DELETE FROM members WHERE workspace_id = ? AND user_id = ?', [c.get('workspaceId'), c.req.param('userId')]);
    return c.json({ ok: true });
  })

  // Clients
  .get('/clients', async (c) => {
    const clients = await all(
      `SELECT cl.id, cl.name, cl.timezone, cl.color, cl.approval_required AS approvalRequired, cl.contact_email AS contactEmail, cl.share_token AS shareToken, cl.archived_at AS archivedAt, cl.voice,
        (SELECT COUNT(*) FROM channels ch WHERE ch.client_id = cl.id) AS channelCount,
        (SELECT COUNT(*) FROM channels ch WHERE ch.client_id = cl.id AND ch.status <> 'ok') AS channelsAtRisk
       FROM clients cl WHERE cl.workspace_id = ? ORDER BY cl.archived_at IS NOT NULL, cl.name`,
      [c.get('workspaceId')],
    );
    return c.json({ clients: clients.map((x) => ({ ...x, voice: parseVoice(x.voice), approvalRequired: !!x.approvalRequired, channelCount: Number(x.channelCount), channelsAtRisk: Number(x.channelsAtRisk) })) });
  })
  .post('/clients', async (c) => {
    const b = await body(c);
    const name = str(b.name, 120);
    if (!name) throw new HttpError(422, 'Give the client a name.');
    if (b.timezone && !isTimeZone(b.timezone)) throw new HttpError(422, 'Unknown time zone.');
    if (b.contactEmail && !isEmail(b.contactEmail)) throw new HttpError(422, 'The contact email is not valid.');
    const ws = await one<{ timezone: string }>('SELECT timezone FROM workspaces WHERE id = ?', [c.get('workspaceId')]);
    const id = newId('cli');
    await run('INSERT INTO clients (id, workspace_id, name, timezone, color, approval_required, share_token, contact_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      c.get('workspaceId'),
      name,
      b.timezone || ws?.timezone || 'UTC',
      /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : '#FF7A1A',
      b.approvalRequired ? 1 : 0,
      token(18),
      b.contactEmail ? String(b.contactEmail).trim().toLowerCase() : null,
      new Date(),
    ]);
    return c.json({ id }, 201);
  })
  .patch('/clients/:id', async (c) => {
    const b = await body(c);
    if (b.timezone !== undefined && !isTimeZone(b.timezone)) throw new HttpError(422, 'Unknown time zone.');
    if (b.contactEmail && !isEmail(b.contactEmail)) throw new HttpError(422, 'The contact email is not valid.');
    const n = await run(
      `UPDATE clients SET name = COALESCE(NULLIF(?, ''), name), timezone = COALESCE(?, timezone), color = COALESCE(?, color),
        approval_required = COALESCE(?, approval_required), contact_email = IF(?, ?, contact_email), archived_at = IF(?, ?, archived_at),
        voice = IF(?, ?, voice)
       WHERE id = ? AND workspace_id = ?`,
      [
        str(b.name, 120),
        b.timezone ?? null,
        /^#[0-9a-fA-F]{6}$/.test(b.color) ? b.color : null,
        typeof b.approvalRequired === 'boolean' ? (b.approvalRequired ? 1 : 0) : null,
        b.contactEmail !== undefined,
        b.contactEmail ? String(b.contactEmail).trim().toLowerCase() : null,
        typeof b.archived === 'boolean',
        b.archived ? new Date() : null,
        b.voice !== undefined,
        b.voice ? JSON.stringify(cleanVoice(b.voice)) : null,
        c.req.param('id'),
        c.get('workspaceId'),
      ],
    );
    if (!n) throw new HttpError(404, 'Client not found.');
    return c.json({ ok: true });
  })
  .post('/clients/:id/rotate-link', async (c) => {
    const t = token(18);
    const n = await run('UPDATE clients SET share_token = ? WHERE id = ? AND workspace_id = ?', [t, c.req.param('id'), c.get('workspaceId')]);
    if (!n) throw new HttpError(404, 'Client not found.');
    return c.json({ shareToken: t });
  })

  // API keys (for scripts and AI agents)
  .get('/api-keys', requireAdmin, async (c) => {
    const keys = await all('SELECT id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC', [c.get('workspaceId')]);
    return c.json({ keys });
  })
  .post('/api-keys', requireAdmin, async (c) => {
    const name = str((await body(c)).name, 120) || 'API key';
    const key = generateApiKey();
    await run('INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      newId('key'),
      c.get('workspaceId'),
      name,
      key.slice(0, 14),
      hashSecret(key),
      c.get('user')!.id,
      new Date(),
    ]);
    return c.json({ key }, 201);
  })
  .delete('/api-keys/:id', requireAdmin, async (c) => {
    await run('DELETE FROM api_keys WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    return c.json({ ok: true });
  })

  // Webhooks
  .get('/webhooks', requireAdmin, async (c) => {
    const hooks = await all('SELECT id, url, secret, created_at AS createdAt, last_status AS lastStatus, last_sent_at AS lastSentAt FROM webhooks WHERE workspace_id = ?', [c.get('workspaceId')]);
    return c.json({ webhooks: hooks });
  })
  .post('/webhooks', requireAdmin, async (c) => {
    const url = str((await body(c)).url, 500);
    if (!/^https:\/\/[^\s]+$/.test(url)) throw new HttpError(422, 'Webhook URLs must start with https://');
    const id = newId('whk');
    await run('INSERT INTO webhooks (id, workspace_id, url, secret, created_at) VALUES (?, ?, ?, ?, ?)', [id, c.get('workspaceId'), url, token(24), new Date()]);
    return c.json({ id }, 201);
  })
  .post('/webhooks/test', requireAdmin, async (c) => {
    await emitEvent(c.get('workspaceId'), 'ping', { message: 'Hello from Surecast' });
    return c.json({ ok: true });
  })
  .delete('/webhooks/:id', requireAdmin, async (c) => {
    await run('DELETE FROM webhooks WHERE id = ? AND workspace_id = ?', [c.req.param('id'), c.get('workspaceId')]);
    return c.json({ ok: true });
  });
