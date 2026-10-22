import './env.js';

import { all, db, migrate, run } from '../src/db.js';
import { overrideAdapter, PublishError, type Adapter, type PublishInput } from '../src/platforms/index.js';
import { encrypt, newId, token } from '../src/util.js';

const TABLES = ['users', 'login_codes', 'sessions', 'workspaces', 'members', 'clients', 'channels', 'media', 'posts', 'post_targets', 'attempts', 'post_comments', 'alerts', 'oauth_states', 'oauth_apps', 'pending_connections', 'api_keys', 'webhooks', 'scheduler_runs', 'ai_usage', 'snippets', 'feeds'];

export async function resetDb() {
  await migrate();
  for (const t of TABLES) await db().query(`DELETE FROM ${t}`);
}

export type Behaviour = 'ok' | 'temporary' | 'auth' | 'permanent' | 'hang';

/** A fake network that does whatever the test queues up next. */
export function fakeAdapter(platform = 'bluesky') {
  const queue: Behaviour[] = [];
  const published: PublishInput[] = [];
  const replyQueue: Behaviour[] = [];
  const replies: { parentId: string; rootId: string; text: string }[] = [];
  let checkResult: Behaviour = 'ok';
  const a: Adapter = {
    platform: platform as Adapter['platform'],
    label: 'Fakebook',
    limits: { maxChars: 300, maxImages: 4, maxImageBytes: 1_000_000, imageTypes: ['image/jpeg', 'image/png'] },
    available: () => true,
    count: (s) => [...s].length,
    connect: {
      kind: 'fields',
      help: '',
      fields: [{ name: 'handle', label: 'Handle', type: 'text', required: true }],
      async submit(v) {
        return { name: v.handle, handle: `@${v.handle}`, externalId: v.handle, avatarUrl: null, credentials: { secret: 'x' }, tokenExpiresAt: null };
      },
    },
    async check() {
      if (checkResult === 'auth') throw new PublishError('auth', 'unauthorized', 'Token revoked', 'Reconnect.', 401);
      return {};
    },
    async publish(_ch, input) {
      const b = queue.shift() ?? 'ok';
      if (b === 'temporary') throw new PublishError('temporary', 'server_error', 'Fakebook returned 503', 'Will retry.', 503);
      if (b === 'auth') throw new PublishError('auth', 'unauthorized', 'Fakebook returned 401', 'Reconnect this channel.', 401);
      if (b === 'permanent') throw new PublishError('permanent', 'rejected', 'Fakebook returned 400: media rejected', 'Edit the post.', 400);
      if (b === 'hang') await new Promise((r) => setTimeout(r, 300));
      published.push(input);
      return { remoteId: `r${published.length}`, url: `https://fake.example/p/${published.length}` };
    },
    followUps: 'thread',
    async reply(_ch, target, text) {
      const b = replyQueue.shift() ?? 'ok';
      if (b === 'temporary') throw new PublishError('temporary', 'server_error', 'Fakebook returned 503', 'Will retry.', 503);
      if (b === 'permanent') throw new PublishError('permanent', 'rejected', 'Fakebook returned 400', 'Edit it.', 400);
      replies.push({ ...target, text });
      return { remoteId: `c${replies.length}`, url: null };
    },
  };
  overrideAdapter(a);
  return {
    queue,
    published,
    replyQueue,
    replies,
    setCheck: (b: Behaviour) => (checkResult = b),
  };
}

export async function seed(opts: { approval?: boolean; platform?: string } = {}) {
  const now = new Date();
  const userId = newId('usr');
  const wsId = newId('wsp');
  const clientId = newId('cli');
  const channelId = newId('chn');
  await run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', [userId, `owner-${userId}@example.com`, 'Owner', now]);
  await run('INSERT INTO workspaces (id, name, timezone, created_at) VALUES (?, ?, ?, ?)', [wsId, 'Test Agency', 'UTC', now]);
  await run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [wsId, userId, now]);
  await run('INSERT INTO clients (id, workspace_id, name, timezone, approval_required, share_token, contact_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    clientId,
    wsId,
    'Acme Bakery',
    'UTC',
    opts.approval ? 1 : 0,
    token(18),
    'client@example.com',
    now,
  ]);
  await run("INSERT INTO channels (id, workspace_id, client_id, platform, name, handle, external_id, credentials, status, last_checked_at, created_at) VALUES (?, ?, ?, ?, 'Acme', '@acme', 'acme', ?, 'ok', ?, ?)", [
    channelId,
    wsId,
    clientId,
    opts.platform ?? 'bluesky',
    encrypt({ secret: 'x' }),
    now,
    now,
  ]);
  return { userId, wsId, clientId, channelId, user: { id: userId, email: `owner-${userId}@example.com`, name: 'Owner' } };
}

export const target = async (postId: string) => (await all('SELECT * FROM post_targets WHERE post_id = ?', [postId]))[0];
export const later = (ms: number) => () => new Date(Date.now() + ms);
