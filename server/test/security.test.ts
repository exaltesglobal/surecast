import './env.js';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { config } from '../src/config.js';
import { closeDb, run } from '../src/db.js';
import { outbox } from '../src/mail.js';
import { hashSecret, newId, token } from '../src/util.js';
import { resetDb, seed } from './helpers.js';

const app = createApp();
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(`/v1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function sessionCookie(userId: string) {
  const t = token(32);
  await run('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [newId('ses'), userId, hashSecret(t), new Date(Date.now() + 3_600_000), new Date()]);
  return `sc_session=${t}`;
}

describe('security', () => {
  beforeEach(resetDb);
  after(closeDb);

  it('locks an address for an hour after 10 wrong codes, even across new codes', async () => {
    const email = 'target@example.com';
    for (let i = 0; i < 10; i++) {
      if (i % 5 === 0) {
        if (i) await run('UPDATE login_codes SET expires_at = ? WHERE email = ?', [new Date(Date.now() + 60_000), email]);
        assert.equal((await post('/auth/code', { email })).status, 200);
      }
      assert.equal((await post('/auth/verify', { email, code: 'x' + i })).status, 401);
    }
    const code = outbox().at(-1)!.subject.match(/(\d{6})/)![1];
    assert.equal((await post('/auth/verify', { email, code })).status, 429, 'even the right code is refused');
    await run('UPDATE login_codes SET expires_at = ? WHERE email = ?', [new Date(Date.now() + 60_000), email]);
    assert.equal((await post('/auth/code', { email })).status, 429);

    // An hour later it works again.
    await run('UPDATE login_codes SET hour_started_at = ?, expires_at = ? WHERE email = ?', [new Date(Date.now() - 3_700_000), new Date(Date.now() + 60_000), email]);
    assert.equal((await post('/auth/code', { email })).status, 200);
    const fresh = outbox().at(-1)!.subject.match(/(\d{6})/)![1];
    assert.equal((await post('/auth/verify', { email, code: fresh })).status, 200);
  });

  it('refuses webhooks that point at private networks', async () => {
    const s = await seed();
    const cookie = await sessionCookie(s.userId);
    for (const url of ['https://127.0.0.1/hook', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://10.0.0.5/a']) {
      const res = await post('/webhooks', { url }, { Cookie: cookie });
      assert.equal(res.status, 422, url);
    }
  });

  it('does not let a staff member’s API key into the admin area', async () => {
    const s = await seed();
    config.adminEmails.push(s.user.email.toLowerCase());
    try {
      const key = generateApiKey();
      await run('INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [newId('key'), s.wsId, 'k', key.slice(0, 14), hashSecret(key), s.userId, new Date()]);
      assert.equal((await app.request('/v1/admin/me', { headers: { Authorization: `Bearer ${key}` } })).status, 404);
      assert.equal((await app.request('/v1/admin/me', { headers: { Cookie: await sessionCookie(s.userId) } })).status, 200);
    } finally {
      config.adminEmails.pop();
    }
  });

  it('only lets the person who started a connection finish it', async () => {
    const s = await seed();
    await run("INSERT INTO oauth_states (state, workspace_id, client_id, user_id, platform, data, expires_at) VALUES ('st1', ?, ?, ?, 'bluesky', '{}', ?)", [s.wsId, s.clientId, s.userId, new Date(Date.now() + 600_000)]);
    const res = await app.request('/v1/oauth/bluesky/callback?state=st1&code=c');
    assert.match(res.headers.get('location')!, /error=Sign%20in/);
  });
});
