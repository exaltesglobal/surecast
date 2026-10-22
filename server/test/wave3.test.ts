import './env.js';

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { closeDb, one, run } from '../src/db.js';
import { checkFeed, parseFeed, renderTemplate } from '../src/engine/feeds.js';
import { fetchPublic } from '../src/engine/fetch.js';
import { parseCsv, previewImport, runImport } from '../src/engine/importer.js';
import { savePost } from '../src/engine/posts.js';
import { tick } from '../src/engine/publisher.js';
import { newId } from '../src/util.js';
import { fakeAdapter, later, resetDb, seed, target } from './helpers.js';

const realFetch = globalThis.fetch;

describe('queues, threads, recycling, CSV import and feeds', () => {
  beforeEach(resetDb);
  afterEach(() => (globalThis.fetch = realFetch));
  after(closeDb);

  it('puts queued posts in the next free posting time, in the client’s time zone', async () => {
    fakeAdapter();
    const s = await seed();
    await run("UPDATE clients SET timezone = 'Asia/Kolkata', queue_slots = ? WHERE id = ?", [JSON.stringify([{ day: 1, time: '09:00' }, { day: 4, time: '18:30' }]), s.clientId]);
    const a = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'First', channelIds: [s.channelId], action: 'queue' });
    const b = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Second', channelIds: [s.channelId], action: 'queue' });
    const pa = (await one('SELECT scheduled_at FROM posts WHERE id = ?', [a]))!.scheduled_at as Date;
    const pb = (await one('SELECT scheduled_at FROM posts WHERE id = ?', [b]))!.scheduled_at as Date;
    assert.ok(pa > new Date() && pb > pa);
    const local = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    assert.ok(['Mon 09:00', 'Thu 18:30'].includes(local(pa)), local(pa));
    assert.ok(['Mon 09:00', 'Thu 18:30'].includes(local(pb)), local(pb));
    await run('UPDATE clients SET queue_slots = NULL WHERE id = ?', [s.clientId]);
    await assert.rejects(savePost(s.wsId, s.user, { clientId: s.clientId, body: 'x', channelIds: [s.channelId], action: 'queue' }), /posting times/);
  });

  it('posts the thread as a chain of replies, then the first comment under the main post', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    fake.replyQueue.push('ok', 'temporary');
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Part 1', thread: ['Part 2', 'Part 3'], firstComment: 'Link: https://acme.example', channelIds: [s.channelId], action: 'now' });
    await tick('test');
    let t = await target(id);
    assert.equal(t.status, 'published');
    // Part 2 went out; part 3 hit a temporary error and waits for its retry.
    assert.equal(t.followups_done, 1);
    assert.match(t.followups_error, /Part 3 of the thread/);
    await tick('test', later(2 * 60_000));
    t = await target(id);
    assert.equal(t.followups_done, 3);
    assert.equal(t.followups_next_at, null);
    assert.deepEqual(
      fake.replies.map((r) => [r.text, r.parentId, r.rootId]),
      [
        ['Part 2', 'r1', 'r1'],
        ['Part 3', 'c1', 'r1'],
        ['Link: https://acme.example', 'r1', 'r1'],
      ],
    );
    assert.equal(fake.published.length, 1);
  });

  it('rejects a thread part that is too long for the network', async () => {
    fakeAdapter();
    const s = await seed();
    await assert.rejects(
      savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Hi', thread: ['y'.repeat(400)], channelIds: [s.channelId], action: 'now' }),
      (e: any) => /Thread part 2 is 400 characters/.test(JSON.stringify(e.details)),
    );
  });

  it('brings evergreen posts back after the chosen number of days, the chosen number of times', async () => {
    fakeAdapter();
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Evergreen tip', channelIds: [s.channelId], action: 'now', recycle: { days: 7, times: 2 } });
    await tick('test');
    const copy = await one("SELECT * FROM posts WHERE recycled_from = ? AND source = 'recycle'", [id]);
    assert.ok(copy);
    assert.equal(copy.recycle_left, 1);
    assert.equal(copy.status, 'scheduled');
    const days = (copy.scheduled_at.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days < 7.1, String(days));
    assert.equal((await one('SELECT recycle_left FROM posts WHERE id = ?', [id]))!.recycle_left, 0);
    // Publishing again does not make a second copy of the original.
    await tick('test');
    assert.equal((await one('SELECT COUNT(*) AS n FROM posts WHERE recycled_from = ?', [id]))!.n, 1);
  });

  it('reads CSV with quotes, commas and semicolons', () => {
    assert.deepEqual(parseCsv('date,text\n2026-11-05,"Hello, ""world""\nline two"\r\n'), [
      ['date', 'text'],
      ['2026-11-05', 'Hello, "world"\nline two'],
    ]);
    assert.deepEqual(parseCsv('﻿date;text\n2026-11-05;Hi, there'), [
      ['date', 'text'],
      ['2026-11-05', 'Hi, there'],
    ]);
  });

  it('previews a CSV import row by row, then saves only the good rows', async () => {
    fakeAdapter();
    const s = await seed();
    const csv = [
      'date,time,text,channels',
      '2099-01-05,14:30,Happy new year from Acme,bluesky',
      '2020-01-01,09:00,Too late,',
      '2099-01-06,9:00 am,Wrong network,linkedin',
      ',,No date goes to drafts,all',
      `2099-01-07,10:00,${'z'.repeat(301)},`,
    ].join('\n');
    const p = await previewImport(s.wsId, s.clientId, csv);
    assert.deepEqual(
      p.rows.map((r) => [r.row, r.when, r.issues.length]),
      [
        [2, 'scheduled', 0],
        [3, 'scheduled', 1],
        [4, 'scheduled', 1],
        [5, 'draft', 0],
        [6, 'scheduled', 1],
      ],
    );
    assert.match(p.rows[2].issues[0], /No channel called "linkedin"/);
    assert.match(p.rows[4].issues[0], /allows 300 characters/);
    const r = await runImport(s.wsId, s.user, s.clientId, csv);
    assert.equal(r.created, 2);
    const scheduled = await one("SELECT * FROM posts WHERE source = 'csv' AND status = 'scheduled'");
    assert.equal(scheduled!.body, 'Happy new year from Acme');
    assert.equal(scheduled!.scheduled_at.toISOString(), '2099-01-05T14:30:00.000Z');
  });

  it('parses RSS and Atom feeds', () => {
    const rss = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>Acme Blog</title>
      <item><title>New &amp; improved</title><link>https://acme.example/a</link><guid>a1</guid><description><![CDATA[<p>Our <b>best</b> bread yet.</p>]]></description></item>
      <item><title>Second</title><link>https://acme.example/b</link></item></channel></rss>`);
    assert.equal(rss.title, 'Acme Blog');
    assert.deepEqual(rss.items.map((i) => [i.id, i.title, i.summary]), [
      ['a1', 'New & improved', 'Our best bread yet.'],
      ['https://acme.example/b', 'Second', ''],
    ]);
    const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title><entry><id>tag:1</id><title>Hello</title><link rel="alternate" href="https://n.example/1"/><updated>2026-10-01T00:00:00Z</updated></entry></feed>`);
    assert.deepEqual(atom.items.map((i) => [i.id, i.link]), [['tag:1', 'https://n.example/1']]);
    assert.equal(renderTemplate('{title}\n\n{link}', rss.items[0]), 'New & improved\n\nhttps://acme.example/a');
  });

  it('turns only new feed articles into posts', async () => {
    fakeAdapter();
    const s = await seed();
    let xml = '<rss><channel><title>Blog</title><item><guid>old</guid><title>Old post</title><link>https://acme.example/old</link></item></channel></rss>';
    globalThis.fetch = (async () => new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } })) as typeof fetch;
    const id = newId('fed');
    await run("INSERT INTO feeds (id, workspace_id, client_id, url, channel_ids, template, mode, created_at) VALUES (?, ?, ?, 'http://93.184.216.34/feed', ?, '{title} {link}', 'draft', ?)", [
      id,
      s.wsId,
      s.clientId,
      JSON.stringify([s.channelId]),
      new Date(),
    ]);
    const feed = async () => (await one('SELECT * FROM feeds WHERE id = ?', [id]))!;
    assert.equal((await checkFeed(await feed())).created, 0);
    xml = xml.replace('<item>', '<item><guid>new</guid><title>Fresh bread</title><link>https://acme.example/new</link></item><item>');
    assert.equal((await checkFeed(await feed())).created, 1);
    const post = await one("SELECT * FROM posts WHERE source = 'rss'");
    assert.equal(post!.body, 'Fresh bread https://acme.example/new');
    assert.equal(post!.status, 'draft');
    assert.equal((await checkFeed(await feed())).created, 0);
  });

  it('refuses to fetch private network addresses', async () => {
    await assert.rejects(fetchPublic('http://127.0.0.1/admin', { maxBytes: 1000 }), /private network/);
    await assert.rejects(fetchPublic('http://192.168.1.1/', { maxBytes: 1000 }), /private network/);
    await assert.rejects(fetchPublic('file:///etc/passwd', { maxBytes: 1000 }), /Only http and https/);
  });
});
