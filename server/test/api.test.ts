import './env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closeDb } from '../src/db.js';
import { tick } from '../src/engine/publisher.js';
import { outbox } from '../src/mail.js';
import { fakeAdapter, resetDb } from './helpers.js';

const app = createApp();
let cookie = '';

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.request(`/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie?.startsWith('sc_session=')) cookie = setCookie.split(';')[0];
  return { status: res.status, data: (await res.json()) as any };
}

describe('HTTP API', () => {
  before(resetDb);
  after(closeDb);

  it('signs in with an email code, schedules a post and reports it as published', async () => {
    const fake = fakeAdapter();
    assert.equal((await api('GET', '/me')).status, 401);
    assert.equal((await api('POST', '/auth/code', { email: 'anup@example.com' })).status, 200);
    const code = outbox().at(-1)!.subject.match(/(\d{6})/)![1];
    assert.equal((await api('POST', '/auth/verify', { email: 'anup@example.com', code: '000000' })).status, 401);
    const verified = await api('POST', '/auth/verify', { email: 'anup@example.com', code, name: 'Anup' });
    assert.equal(verified.status, 200);
    const me = await api('GET', '/me');
    assert.equal(me.data.workspaces.length, 1);

    const client = await api('POST', '/clients', { name: 'Acme Bakery', timezone: 'Asia/Kolkata' });
    assert.equal(client.status, 201);
    const connected = await api('POST', '/channels/connect', { clientId: client.data.id, platform: 'bluesky', values: { handle: 'acme' } });
    assert.equal(connected.status, 200, JSON.stringify(connected.data));

    const tooLong = await api('POST', '/posts', { clientId: client.data.id, body: 'x'.repeat(400), channelIds: [connected.data.channelId], action: 'now' });
    assert.equal(tooLong.status, 422);
    assert.match(tooLong.data.details[0].issues[0], /allows 300 characters/);

    const created = await api('POST', '/posts', { clientId: client.data.id, body: 'Hello from Surecast', channelIds: [connected.data.channelId], action: 'now' });
    assert.equal(created.status, 201);
    await tick('test');
    const post = await api('GET', `/posts/${created.data.post.id}`);
    assert.equal(post.data.post.status, 'published');
    assert.equal(post.data.post.targets[0].log[0].outcome, 'success');
    assert.equal(fake.published.length, 1);

    const dash = await api('GET', '/dashboard');
    assert.equal(dash.data.stats.published24h, 1);
    assert.equal(dash.data.scheduler.healthy, true);

    const clients = await api('GET', '/clients');
    const report = await api('GET', `/public/report/${clients.data.clients[0].shareToken}`);
    assert.equal(report.data.summary.published, 1);
    assert.equal(report.data.items[0].url, 'https://fake.example/p/1');
  });

  it('lets an API key schedule posts', async () => {
    const key = await api('POST', '/api-keys', { name: 'Agent' });
    assert.equal(key.status, 201);
    const saved = cookie;
    cookie = '';
    const clients = await api('GET', '/clients', undefined, { Authorization: `Bearer ${key.data.key}` });
    assert.equal(clients.status, 200);
    assert.equal(clients.data.clients.length, 1);
    cookie = saved;
  });

  it('protects the cron endpoint', async () => {
    assert.equal((await api('GET', '/cron/tick?key=wrong')).status, 403);
    assert.equal((await api('GET', '/cron/tick?key=cron-test')).status, 200);
  });
});
