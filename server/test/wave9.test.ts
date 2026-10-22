import './env.js';

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { generateApiKey } from '../src/auth.js';
import { config } from '../src/config.js';
import { closeDb, one, run } from '../src/db.js';
import { mediaData, mediaFiles, mediaMeta, storeMedia } from '../src/engine/content.js';
import { disconnectDrive, finishDrive, getDrive, startDrive } from '../src/engine/drive.js';
import { savePost } from '../src/engine/posts.js';
import { hashSecret, newId } from '../src/util.js';
import { fakeAdapter, resetDb, seed } from './helpers.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(500, 3)]);
const realFetch = globalThis.fetch;

/** A fake Google: OAuth, userinfo and a Drive that keeps files in memory. */
function fakeGoogle() {
  const files = new Map<string, Buffer>();
  const calls: { method: string; url: string }[] = [];
  let next = 0;
  const state = { failUploads: false, trashed: [] as string[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    const j = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
    if (url === 'https://oauth2.googleapis.com/token') return j({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file' });
    if (url.endsWith('/oauth2/v3/userinfo')) return j({ email: 'media@agency.example' });
    if (url.includes('/drive/v3/files?fields=id') && method === 'POST') return j({ id: 'folder1' });
    if (url.includes('/upload/drive/v3/files?uploadType=resumable')) return state.failUploads ? j({ error: { message: 'Storage quota exceeded' } }, 403) : j({}, 200, { Location: 'https://upload.example/s1' });
    if (url === 'https://upload.example/s1') {
      const id = `file${++next}`;
      files.set(id, Buffer.from(init.body as Uint8Array));
      return j({ id });
    }
    const m = url.match(/\/drive\/v3\/files\/([^?]+)(\?alt=media)?$/);
    if (m && m[2]) return files.has(m[1]) ? new Response(new Uint8Array(files.get(m[1])!)) : j({ error: { message: 'File not found' } }, 404);
    if (m && method === 'PATCH') {
      state.trashed.push(m[1]);
      return j({ id: m[1] });
    }
    return j({ error: { message: `unexpected ${method} ${url}` } }, 500);
  }) as typeof fetch;
  return { files, calls, state };
}

async function connect(wsId: string, userId: string) {
  const url = new URL(await startDrive(wsId, userId));
  assert.match(url.searchParams.get('scope')!, /drive\.file/);
  assert.equal(url.searchParams.get('redirect_uri'), `${config.publicUrl}/v1/oauth/gdrive/callback`);
  await finishDrive(url.searchParams.get('state')!, 'code1');
}

describe('wave 9: media in Google Drive', () => {
  beforeEach(async () => {
    await resetDb();
    config.google ??= { id: 'gid', secret: 'gsecret' };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(closeDb);

  it('saves new uploads to the connected Drive and reads them back when posting', async () => {
    const g = fakeGoogle();
    const s = await seed();
    const before = await storeMedia(s.wsId, PNG, 'old.png');
    assert.equal(before.storage, 'surecast');

    await connect(s.wsId, s.userId);
    const drive = await getDrive(s.wsId);
    assert.equal(drive!.account_name, 'media@agency.example');

    const m = await storeMedia(s.wsId, PNG, 'launch.png');
    assert.equal(m.storage, 'drive');
    const row = await one<{ drive_file_id: string; data: Buffer }>('SELECT drive_file_id, data FROM media WHERE id = ?', [m.id]);
    assert.equal(row!.drive_file_id, 'file1');
    assert.equal(row!.data.length, 0);
    assert.ok((await mediaData(m.id)).equals(PNG));
    assert.ok((await mediaData(before.id)).equals(PNG));

    // A file deleted from Drive gives a clear reason.
    g.files.delete('file1');
    await assert.rejects(mediaData(m.id, 'launch.png'), /launch\.png was removed from Google Drive/);
    // When posting, that is a permanent failure rather than something to retry.
    const [file] = mediaFiles(await mediaMeta([m.id]));
    await assert.rejects(file.data(), (e: any) => e.kind === 'permanent' && e.code === 'drive_media');
  });

  it('keeps the upload in Surecast when Drive fails, and shows the problem', async () => {
    const g = fakeGoogle();
    const s = await seed();
    await connect(s.wsId, s.userId);
    g.state.failUploads = true;
    const m = await storeMedia(s.wsId, PNG, 'a.png');
    assert.equal(m.storage, 'surecast');
    assert.ok((await mediaData(m.id)).equals(PNG));
    const drive = await getDrive(s.wsId);
    assert.equal(drive!.status, 'error');
    assert.match(drive!.last_error!, /quota/);
  });

  it('copies files for upcoming posts back into Surecast on disconnect', async () => {
    fakeGoogle();
    fakeAdapter();
    const s = await seed();
    await connect(s.wsId, s.userId);
    const used = await storeMedia(s.wsId, PNG, 'used.png');
    const spare = await storeMedia(s.wsId, PNG, 'spare.png');
    await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Soon', mediaIds: [used.id], channelIds: [s.channelId], action: 'schedule', scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });

    assert.deepEqual(await disconnectDrive(s.wsId), { copied: 1, leftInDrive: 1 });
    assert.equal(await getDrive(s.wsId), null);
    assert.ok((await mediaData(used.id)).equals(PNG));
    assert.equal((await one<{ drive_file_id: string | null }>('SELECT drive_file_id FROM media WHERE id = ?', [used.id]))!.drive_file_id, null);
    await assert.rejects(mediaData(spare.id, 'spare.png'), /no longer connected/);
  });

  it('routes the Google callback to Drive, and trashes files deleted in Surecast', async () => {
    const g = fakeGoogle();
    const s = await seed();
    const app = createApp();
    const url = new URL(await startDrive(s.wsId, s.userId));
    const res = await app.request(`/v1/oauth/gdrive/callback?state=${url.searchParams.get('state')}&code=c`);
    assert.equal(res.headers.get('location'), '/settings?drive=connected#drive');
    const bad = await app.request('/v1/oauth/gdrive/callback?state=nope&code=c');
    assert.match(bad.headers.get('location')!, /driveError=That%20connection%20link%20expired/);

    const m = await storeMedia(s.wsId, PNG, 'x.png');
    const key = generateApiKey();
    await run('INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [newId('key'), s.wsId, 'k', key.slice(0, 14), hashSecret(key), s.userId, new Date()]);
    const del = await app.request(`/v1/media/${m.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` } });
    assert.equal(del.status, 200);
    assert.deepEqual(g.state.trashed, ['file1']);
  });
});
