import './env.js';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { all, closeDb, one, run } from '../src/db.js';
import { analytics, analyticsCsv, bestTimes } from '../src/engine/analytics.js';
import { renderBio, saveBio } from '../src/engine/bio.js';
import { openLink, prepareLinks, withUtm } from '../src/engine/links.js';
import { collectFollowers, collectMetrics } from '../src/engine/metrics.js';
import { savePost } from '../src/engine/posts.js';
import { tick } from '../src/engine/publisher.js';
import { newId } from '../src/util.js';
import { fakeAdapter, later, resetDb, seed, target } from './helpers.js';

const BROWSER = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const HOUR = 3_600_000;

/** A published post with numbers, published at a given time. */
async function publishedPost(s: Awaited<ReturnType<typeof seed>>, at: Date, m: { likes: number; comments?: number; shares?: number; clicks?: number }, body = 'Hello') {
  const postId = newId('pst');
  await run("INSERT INTO posts (id, workspace_id, client_id, status, body, media_ids, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, 'published', ?, '[]', ?, ?, ?)", [postId, s.wsId, s.clientId, body, at, at, at]);
  await run(
    "INSERT INTO post_targets (id, post_id, workspace_id, channel_id, status, due_at, published_at, remote_id, remote_url, likes, comments, shares, clicks, metrics_at, updated_at) VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [newId('tgt'), postId, s.wsId, s.channelId, at, at, `r-${postId}`, `https://fake.example/${postId}`, m.likes, m.comments ?? 0, m.shares ?? 0, m.clicks ?? 0, new Date(), at],
  );
  return postId;
}

describe('analytics, short links and link-in-bio pages', () => {
  beforeEach(resetDb);
  after(closeDb);

  it('reads engagement back from the network, then slows down as the post ages', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Fresh bread', channelIds: [s.channelId], action: 'now' });
    await tick('test'); // the tick's own first read finds no numbers yet
    fake.stats.r1 = { likes: 12, comments: 3, shares: 2, views: null };
    const at = (min: number) => new Date(Date.now() + min * 60_000);
    assert.equal(await collectMetrics(at(61)), 1);
    let t = await target(id);
    assert.deepEqual([t.likes, t.comments, t.shares], [12, 3, 2]);
    // Asked again right away: nothing is due yet.
    fake.stats.r1 = { likes: 20, comments: 3, shares: 2, views: null };
    assert.equal(await collectMetrics(at(62)), 0);
    // An hour later the fresh post is due again.
    assert.equal(await collectMetrics(at(125)), 1);
    t = await target(id);
    assert.equal(t.likes, 20);
  });

  it('records follower counts once per day for trends', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    await collectFollowers();
    fake.audience.followers = 140;
    await collectFollowers(); // too soon: skipped
    assert.equal((await one('SELECT followers FROM channels WHERE id = ?', [s.channelId]))!.followers, 100);
    await collectFollowers(new Date(Date.now() + 13 * HOUR));
    assert.equal((await one('SELECT followers FROM channels WHERE id = ?', [s.channelId]))!.followers, 140);
    const rows = await all('SELECT * FROM channel_stats WHERE channel_id = ?', [s.channelId]);
    assert.ok(rows.length >= 1 && rows.length <= 2);
  });

  it('swaps links for tracked short links with UTM tags, per network, and reuses them on retry', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    await run('UPDATE clients SET link_settings = ? WHERE id = ?', [JSON.stringify({ track: true, utm: true, campaign: 'autumn' }), s.clientId]);
    fake.queue.push('temporary');
    const id = await savePost(s.wsId, s.user, {
      clientId: s.clientId,
      body: 'New menu: https://acme.example/menu?x=1 and https://acme.example/menu?x=1/more',
      firstComment: 'Book at https://acme.example/book',
      channelIds: [s.channelId],
      action: 'now',
    });
    await tick('test');
    await tick('test', later(2 * 60_000));
    const sent = fake.published[0].text;
    const codes = [...sent.matchAll(/http:\/\/localhost:3000\/l\/([a-z0-9]{7})/g)].map((m) => m[1]);
    assert.equal(codes.length, 2, sent);
    assert.equal((await all('SELECT * FROM links')).length, 3, 'two body links + the first comment link, no duplicates from the retry');
    const link = (await one('SELECT * FROM links WHERE code = ?', [codes[0]]))!;
    assert.equal(link.platform, 'bluesky');
    assert.match(link.url, /utm_source=bluesky&utm_medium=social&utm_campaign=autumn/);
    assert.match(fake.replies[0].text, /^Book at http:\/\/localhost:3000\/l\//);
    // Clicks from people count; link-preview fetchers from the networks do not.
    assert.equal(await openLink(codes[0], BROWSER, 'https://bsky.app/'), link.url);
    await openLink(codes[0], 'Mastodon/4.3.0 (http.rb/5.2.0; +https://mastodon.social/)', null);
    await openLink(codes[0], 'facebookexternalhit/1.1', null);
    assert.equal((await target(id)).clicks, 1);
    assert.equal((await one('SELECT referrer FROM link_clicks'))!.referrer, 'bsky.app');
    // The same target and URL always get the same code.
    const again = await prepareLinks('https://acme.example/menu?x=1', { workspaceId: s.wsId, clientId: s.clientId, postId: id, targetId: (await target(id)).id, platform: 'bluesky' });
    assert.ok(codes.some((c) => again.endsWith(`/l/${c}`)), again);
  });

  it('leaves existing UTM tags alone and skips links when tracking is off', async () => {
    assert.equal(withUtm('https://a.example/?utm_source=news', 'x', ''), 'https://a.example/?utm_source=news');
    assert.equal(withUtm('https://a.example/p', 'x', ''), 'https://a.example/p?utm_source=x&utm_medium=social&utm_campaign=surecast');
    const fake = fakeAdapter();
    const s = await seed();
    await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'See https://acme.example', channelIds: [s.channelId], action: 'now' });
    await tick('test');
    assert.equal(fake.published[0].text, 'See https://acme.example');
  });

  it('serves short links over HTTP and 404s unknown codes', async () => {
    fakeAdapter();
    const s = await seed();
    await run("INSERT INTO links (code, workspace_id, client_id, scope, url, url_hash, created_at) VALUES ('abc1234', ?, ?, 'x', 'https://acme.example/', 'h', ?)", [s.wsId, s.clientId, new Date()]);
    const app = createApp();
    const res = await app.request('/l/abc1234', { headers: { 'User-Agent': BROWSER } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://acme.example/');
    assert.equal((await app.request('/l/nope000')).status, 404);
  });

  it('adds up results, compares with the previous period and lists top posts', async () => {
    fakeAdapter();
    const s = await seed();
    const now = Date.now();
    await publishedPost(s, new Date(now - 2 * 86_400_000), { likes: 10, comments: 2, shares: 1, clicks: 4 }, 'Best one');
    await publishedPost(s, new Date(now - 3 * 86_400_000), { likes: 1 });
    await publishedPost(s, new Date(now - 40 * 86_400_000), { likes: 5 });
    const a = await analytics(s.wsId, { clientId: s.clientId, days: 30 });
    assert.equal(a.summary.posts, 2);
    assert.equal(a.summary.engagement, 14);
    assert.equal(a.summary.clicks, 4);
    assert.equal(a.previous.posts, 1);
    assert.equal(a.top[0].text, 'Best one');
    assert.equal(a.daily.length, 30);
    assert.equal(a.daily.reduce((n, d) => n + d.posts, 0), 2);
    assert.equal(a.networks[0].platform, 'bluesky');
  });

  it('suggests general posting times until a client has enough results, then their own best slots', async () => {
    fakeAdapter();
    const s = await seed();
    assert.equal((await bestTimes(s.wsId, s.clientId)).basis, 'general');
    // Tuesdays at 18:00 UTC do far better than Mondays at 08:00.
    const base = new Date('2026-09-01T18:00:00Z'); // a Tuesday
    const back = Math.ceil((Date.now() - base.getTime()) / (7 * 86_400_000)) * 7 * 86_400_000;
    for (let w = 1; w <= 6; w++) {
      await publishedPost(s, new Date(base.getTime() + back - w * 7 * 86_400_000), { likes: 50 });
      await publishedPost(s, new Date(base.getTime() + back - w * 7 * 86_400_000 - 6 * 86_400_000 - 10 * HOUR), { likes: 2 });
    }
    const b = await bestTimes(s.wsId, s.clientId);
    assert.equal(b.basis, 'data');
    assert.deepEqual([b.slots[0].day, b.slots[0].time], [2, '18:00']);
  });

  it('exports CSV with formulas neutralised', async () => {
    fakeAdapter();
    const s = await seed();
    await publishedPost(s, new Date(Date.now() - HOUR), { likes: 3 }, '=HYPERLINK("http://evil")');
    const csv = await analyticsCsv(s.wsId, { days: 7 });
    assert.match(csv, /^published_at,client,network/);
    assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
  });

  it('publishes a link-in-bio page with tracked buttons and the latest posts', async () => {
    fakeAdapter();
    const s = await seed();
    await assert.rejects(saveBio(s.wsId, s.clientId, { slug: 'Bad Slug!' }), /lowercase/);
    await assert.rejects(saveBio(s.wsId, s.clientId, { links: [{ label: 'Menu', url: 'javascript:alert(1)' }] }), /https/);
    const page = await saveBio(s.wsId, s.clientId, { slug: 'acme', title: 'Acme <Bakery>', bio: 'Fresh daily', links: [{ label: 'Order online', url: 'https://acme.example/order' }] });
    assert.equal(page.slug, 'acme');
    await publishedPost(s, new Date(Date.now() - HOUR), { likes: 1 }, 'Pumpkin croissants https://acme.example/pumpkin');
    const html = (await renderBio('acme'))!;
    assert.match(html, /Acme &lt;Bakery&gt;/);
    assert.match(html, /href="http:\/\/localhost:3000\/l\/[a-z0-9]{7}" rel="noopener">Order online/);
    assert.match(html, /Pumpkin croissants/);
    assert.equal((await all("SELECT * FROM links WHERE scope = ?", [`bio:${s.clientId}`])).length, 2);
    // A second client cannot take the same address.
    const other = newId('cli');
    await run("INSERT INTO clients (id, workspace_id, name, timezone, approval_required, share_token, created_at) VALUES (?, ?, 'Other', 'UTC', 0, 'tok-other', ?)", [other, s.wsId, new Date()]);
    await assert.rejects(saveBio(s.wsId, other, { slug: 'acme', title: 'Other' }), /already taken/);
    await saveBio(s.wsId, s.clientId, { published: false });
    assert.equal(await renderBio('acme'), null);
  });
});
