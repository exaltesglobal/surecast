import './env.js';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closeDb } from '../src/db.js';
import { outbox } from '../src/mail.js';
import { resetDb } from './helpers.js';

describe('wave 8: one login, many workspaces', () => {
  beforeEach(resetDb);
  after(closeDb);

  it('creates a workspace, switches to it, and keeps brands apart', async () => {
    const app = createApp();
    const jar = new Map<string, string>();
    let ws: string | undefined;
    const api = async (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (ws) headers['X-Workspace-Id'] = ws;
      const res = await app.request(`/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        if (v) jar.set(k, v);
      }
      return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
    };

    await api('POST', '/auth/code', { email: 'anup@agency.example' });
    const code = outbox().at(-1)!.subject.match(/(\d{6})/)![1];
    assert.equal((await api('POST', '/auth/verify', { email: 'anup@agency.example', code, name: 'Anup' })).status, 200);
    const me = (await api('GET', '/me')).data;
    assert.equal(me.workspaces.length, 1);
    assert.equal(me.workspaces[0].name, "Anup's workspace");
    const first = me.workspaceId;
    ws = first;
    assert.equal((await api('POST', '/clients', { name: 'Acme Bakery' })).status, 201);

    assert.equal((await api('POST', '/workspaces', { name: '  ' })).status, 422);
    const made = await api('POST', '/workspaces', { name: 'Hotel group', timezone: 'Asia/Kolkata' });
    assert.equal(made.status, 201);
    assert.deepEqual({ ...made.data.workspace, id: undefined }, { id: undefined, name: 'Hotel group', timezone: 'Asia/Kolkata', role: 'owner' });

    ws = made.data.workspace.id;
    const now = (await api('GET', '/me')).data;
    assert.equal(now.workspaceId, ws);
    assert.equal(now.workspaces.length, 2);
    assert.deepEqual((await api('GET', '/clients')).data.clients, []);
    ws = first;
    assert.deepEqual(
      (await api('GET', '/clients')).data.clients.map((c: any) => c.name),
      ['Acme Bakery'],
    );
  });
});
