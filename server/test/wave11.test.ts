import './env.js';

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../src/config.js';
import { all, closeDb, one, run } from '../src/db.js';
import { collectChannelComments, listInbox, replyToItem } from '../src/engine/inbox.js';
import { encrypt, newId } from '../src/util.js';
import { resetDb, seed } from './helpers.js';

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const snippet = (author: string, text: string, at: string) => ({ authorDisplayName: author, authorChannelId: { value: author === 'Acme' ? 'UCacme' : `UC${author}` }, textOriginal: text, publishedAt: at });

describe('wave 11: channel-wide comments in the inbox', () => {
  beforeEach(async () => {
    await resetDb();
    config.google ??= { id: 'gid', secret: 'gsecret' };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(closeDb);

  async function youtubeChannel() {
    const s = await seed({ platform: 'youtube' });
    await run('UPDATE channels SET credentials = ?, token_expires_at = ? WHERE id = ?', [
      encrypt({ accessToken: 't', refreshToken: 'r', channelId: 'UCacme' }),
      new Date(Date.now() + 3_600_000),
      s.channelId,
    ]);
    return s;
  }

  it('brings in YouTube comments on any video and replies in the right thread', async () => {
    const s = await youtubeChannel();
    // One video was posted through Surecast, the other directly on YouTube.
    const postId = newId('pst');
    const targetId = newId('tgt');
    await run("INSERT INTO posts (id, workspace_id, client_id, body, media_ids, status, created_at, updated_at) VALUES (?, ?, ?, 'Launch video', '[]', 'published', ?, ?)", [
      postId,
      s.wsId,
      s.clientId,
      new Date(),
      new Date(),
    ]);
    await run("INSERT INTO post_targets (id, post_id, workspace_id, channel_id, status, remote_id, published_at, updated_at) VALUES (?, ?, ?, ?, 'published', 'vidSurecast', ?, ?)", [
      targetId,
      postId,
      s.wsId,
      s.channelId,
      new Date(),
      new Date(),
    ]);
    const threads = [
      {
        id: 't1',
        snippet: { videoId: 'vidOutside', topLevelComment: { id: 'c1', snippet: snippet('Priya', 'Love this!', '2026-10-22T10:00:00Z') } },
        replies: { comments: [{ id: 'c1r1', snippet: snippet('Ravi', 'Same here, where is it?', '2026-10-22T11:00:00Z') }] },
      },
      {
        id: 't2',
        snippet: { videoId: 'vidSurecast', topLevelComment: { id: 'c2', snippet: snippet('Meena', 'Price?', '2026-10-22T09:00:00Z') } },
        replies: { comments: [{ id: 'c2r1', snippet: snippet('Acme', 'Rs 499', '2026-10-22T09:30:00Z') }] },
      },
      { id: 't3', snippet: { videoId: 'vidOutside', topLevelComment: { id: 'c3', snippet: snippet('Acme', 'Pinned: links below', '2026-10-21T09:00:00Z') } } },
    ];
    const posts: { url: string; body: any }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.includes('/commentThreads?') && url.includes('allThreadsRelatedToChannelId=UCacme')) return json({ items: threads });
      if (url.includes('/comments?part=snippet') && init.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return json({ id: 'myreply' });
      }
      return json({ error: { message: 'unexpected' } }, 500);
    }) as typeof fetch;

    assert.equal(await collectChannelComments(), 3);
    const items = (await listInbox(s.wsId, {})).items;
    const byText = Object.fromEntries(items.map((i) => [i.text, i]));
    assert.deepEqual(Object.keys(byText).sort(), ['Love this!', 'Price?', 'Same here, where is it?']);
    assert.equal(byText['Love this!'].postId, null);
    assert.equal(byText['Love this!'].isReview, false);
    assert.equal(byText['Price?'].postId, postId);
    assert.equal(byText['Price?'].status, 'done', 'already answered on YouTube');
    assert.equal(byText['Same here, where is it?'].isReplyToComment, true);

    // Checked again within 10 minutes: nothing is fetched twice.
    assert.equal(await collectChannelComments(), 0);

    await replyToItem(s.wsId, s.user, byText['Same here, where is it?'].id, 'It is in the description.');
    assert.equal(posts[0].body.snippet.parentId, 'c1', 'a reply to a reply goes under the top comment');
    await replyToItem(s.wsId, s.user, byText['Love this!'].id, 'Thank you!');
    assert.equal(posts[1].body.snippet.parentId, 'c1');
    const after = await one<{ status: string; reply_remote_id: string }>('SELECT status, reply_remote_id FROM inbox_items WHERE id = ?', [byText['Love this!'].id]);
    assert.equal(after?.status, 'done');
  });

  it('raises an alert when comments cannot be read, and clears it once they can', async () => {
    const s = await youtubeChannel();
    let fail = true;
    globalThis.fetch = (async () =>
      fail ? json({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }, 403) : json({ items: [] })) as typeof fetch;
    await collectChannelComments();
    const open = await all<{ title: string; resolved_at: Date | null }>('SELECT title, resolved_at FROM alerts WHERE workspace_id = ?', [s.wsId]);
    assert.equal(open.length, 1);
    assert.match(open[0].title, /cannot read comments from YouTube/);
    assert.equal(open[0].resolved_at, null);

    fail = false;
    await run('UPDATE channels SET comments_checked_at = NULL WHERE id = ?', [s.channelId]);
    await collectChannelComments();
    const later = await one<{ resolved_at: Date | null }>('SELECT resolved_at FROM alerts WHERE workspace_id = ?', [s.wsId]);
    assert.notEqual(later?.resolved_at, null);
  });
});
