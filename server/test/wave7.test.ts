import './env.js';

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../src/config.js';
import { closeDb, one, run } from '../src/db.js';
import { contentIssues, mediaData, mediaFiles, mediaMeta, storeMedia } from '../src/engine/content.js';
import { adapter, type ChannelCtx } from '../src/platforms/index.js';
import { chunkPlan } from '../src/platforms/tiktok.js';
import { videoParts } from '../src/platforms/youtube.js';
import { resetDb, seed } from './helpers.js';

/** A tiny but genuine-looking MP4 header followed by filler, so sniffing sees a video. */
function fakeMp4(size: number) {
  const buf = Buffer.alloc(size, 7);
  buf.writeUInt32BE(24, 0);
  buf.write('ftypisom', 4, 'ascii');
  return buf;
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const realFetch = globalThis.fetch;
function fakeFetch(answer: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(call);
    const a = answer(call);
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json', ...a.headers } });
  }) as typeof fetch;
  return calls;
}

const ctx = (credentials: Record<string, unknown>): ChannelCtx => ({
  id: 'chn_test',
  handle: '@acme',
  externalId: 'acme',
  credentials,
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  saveCredentials: async () => {},
});

describe('wave 7: video and the YouTube and TikTok networks', () => {
  beforeEach(resetDb);
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(closeDb);

  it('stores videos in chunks and gives the same bytes back', async () => {
    const { wsId } = await seed();
    const video = fakeMp4(9_500_000);
    const { id, mime, key } = await storeMedia(wsId, video, 'launch.mp4');
    assert.equal(mime, 'video/mp4');
    const row = await one<{ chunks: number; size: number }>('SELECT chunks, size FROM media WHERE id = ?', [id]);
    assert.equal(row!.chunks, 3);
    assert.equal(row!.size, video.length);
    assert.ok((await mediaData(id)).equals(video));
    const [file] = mediaFiles(await mediaMeta([id]));
    assert.ok((await file.data()).equals(video));
    assert.ok(file.url.endsWith(`/m/${key}`));

    await assert.rejects(storeMedia(wsId, Buffer.from('not a video or image'), 'x.bin'), /MP4, MOV or WebM/);
    await assert.rejects(storeMedia(wsId, fakeMp4(100_000_001), 'huge.mp4'), /100 MB/);
  });

  it('only lets video networks take videos, and requires one on YouTube and TikTok', () => {
    const vid = { mime: 'video/mp4', size: 20_000_000, filename: 'a.mp4' };
    const img = { mime: 'image/jpeg', size: 200_000, filename: 'a.jpg' };
    assert.deepEqual(contentIssues(adapter('youtube'), 'Title', [vid]), []);
    assert.match(contentIssues(adapter('youtube'), 'Title', [])[0], /need a video/);
    assert.match(contentIssues(adapter('tiktok'), 'Caption', [img]).join(' '), /need a video/);
    assert.match(contentIssues(adapter('tiktok'), 'Caption', [vid, img]).join(' '), /one video per post/);
    assert.match(contentIssues(adapter('bluesky'), 'Hello', [vid])[0], /can't include videos yet/);
    assert.deepEqual(contentIssues(adapter('bluesky'), 'Hello', [img]), []);
  });

  it('turns post text into a YouTube title and description', () => {
    assert.deepEqual(videoParts('Our <new> menu\nCome try it.\nSee you!'), { title: 'Our new menu', description: 'Come try it.\nSee you!' });
    assert.equal(videoParts('x'.repeat(150)).title.length, 100);
    assert.equal(videoParts('   ').title, 'New video');
  });

  it('uploads a video to YouTube with a resumable upload', async () => {
    config.google ??= { id: 'gid', secret: 'gsecret' };
    const { wsId } = await seed();
    const { id } = await storeMedia(wsId, fakeMp4(5_000_000), 'clip.mp4');
    const calls = fakeFetch((c) => {
      if (c.url.includes('uploadType=resumable')) return { headers: { Location: 'https://upload.example/session1' } };
      if (c.url === 'https://upload.example/session1') return { body: { id: 'vid123', status: { privacyStatus: 'public' } } };
      return { status: 500 };
    });
    const r = await adapter('youtube').publish(ctx({ accessToken: 't', refreshToken: 'r', channelId: 'UC1' }), {
      text: 'Big launch\nAll the details here.',
      media: mediaFiles(await mediaMeta([id])),
      idempotencyKey: 'k',
    });
    assert.deepEqual(r, { remoteId: 'vid123', url: 'https://www.youtube.com/watch?v=vid123' });
    const init = JSON.parse(String(calls[0].body));
    assert.equal(init.snippet.title, 'Big launch');
    assert.equal(calls[0].headers['X-Upload-Content-Length'], '5000000');
    assert.equal(calls[1].method, 'PUT');
  });

  it('treats a YouTube quota error as a retry, not a failure', async () => {
    config.google ??= { id: 'gid', secret: 'gsecret' };
    const { wsId } = await seed();
    const { id } = await storeMedia(wsId, fakeMp4(1_000_000), 'clip.mp4');
    fakeFetch(() => ({ status: 403, body: { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } } }));
    await assert.rejects(
      adapter('youtube').publish(ctx({ accessToken: 't', refreshToken: 'r', channelId: 'UC1' }), { text: 'T', media: mediaFiles(await mediaMeta([id])), idempotencyKey: 'k' }),
      (e: any) => e.kind === 'temporary' && e.code === 'rate_limited' && e.retryAfter instanceof Date,
    );
  });

  it('plans TikTok upload chunks within TikTok limits', () => {
    assert.deepEqual(chunkPlan(3_000_000), { chunkSize: 3_000_000, count: 1 });
    assert.deepEqual(chunkPlan(64_000_000), { chunkSize: 64_000_000, count: 1 });
    const big = chunkPlan(95_000_000);
    assert.equal(big.count, 9);
    assert.ok(95_000_000 - big.chunkSize * (big.count - 1) <= 128_000_000);
  });

  it('posts a video to TikTok and waits for the post id', async () => {
    config.tiktok ??= { id: 'tkey', secret: 'tsecret' };
    const { wsId } = await seed();
    const { id } = await storeMedia(wsId, fakeMp4(2_000_000), 'clip.mp4');
    let polls = 0;
    const calls = fakeFetch((c) => {
      if (c.url.endsWith('/creator_info/query/')) return { body: { data: { privacy_level_options: ['SELF_ONLY', 'PUBLIC_TO_EVERYONE'] }, error: { code: 'ok' } } };
      if (c.url.endsWith('/video/init/')) return { body: { data: { publish_id: 'pub1', upload_url: 'https://upload.tiktok.example/u1' }, error: { code: 'ok' } } };
      if (c.url === 'https://upload.tiktok.example/u1') return { status: 201 };
      if (c.url.endsWith('/status/fetch/')) {
        polls++;
        return { body: { data: polls < 2 ? { status: 'PROCESSING_UPLOAD' } : { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7123] }, error: { code: 'ok' } } };
      }
      return { status: 500 };
    });
    // Skip the 5-second waits between status checks.
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof setTimeout;
    try {
      const r = await adapter('tiktok').publish(ctx({ accessToken: 't', refreshToken: 'r', openId: 'o1', username: 'acmebakery' }), {
        text: 'Fresh bread every morning',
        media: mediaFiles(await mediaMeta([id])),
        idempotencyKey: 'k',
      });
      assert.deepEqual(r, { remoteId: '7123', url: 'https://www.tiktok.com/@acmebakery/video/7123' });
    } finally {
      globalThis.setTimeout = realTimeout;
    }
    const init = JSON.parse(String(calls.find((c) => c.url.endsWith('/video/init/'))!.body));
    assert.equal(init.post_info.privacy_level, 'PUBLIC_TO_EVERYONE');
    assert.equal(init.source_info.total_chunk_count, 1);
    assert.equal(calls.find((c) => c.method === 'PUT')!.headers['Content-Range'], 'bytes 0-1999999/2000000');
  });
});
