import './env.js';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { all, closeDb, one, run } from '../src/db.js';
import { decideApproval, savePost } from '../src/engine/posts.js';
import { publishTarget, tick } from '../src/engine/publisher.js';
import { outbox } from '../src/mail.js';
import { fakeAdapter, later, resetDb, seed, target } from './helpers.js';

const MIN = 60_000;

describe('publishing engine', () => {
  beforeEach(resetDb);
  after(closeDb);

  it('publishes a due post and records the attempt', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Fresh bread today', channelIds: [s.channelId], action: 'now' });
    await tick('test');
    const t = await target(id);
    assert.equal(t.status, 'published');
    assert.equal(t.remote_url, 'https://fake.example/p/1');
    assert.equal(fake.published[0].text, 'Fresh bread today');
    assert.equal((await one('SELECT status FROM posts WHERE id = ?', [id]))!.status, 'published');
    const attempts = await all('SELECT outcome FROM attempts WHERE target_id = ?', [t.id]);
    assert.deepEqual(attempts.map((a) => a.outcome), ['success']);
  });

  it('does not publish before the scheduled time', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Later', channelIds: [s.channelId], action: 'schedule', scheduledAt: new Date(Date.now() + 60 * MIN).toISOString() });
    await tick('test');
    assert.equal((await target(id)).status, 'scheduled');
    assert.equal(fake.published.length, 0);
    await tick('test', later(61 * MIN));
    assert.equal((await target(id)).status, 'published');
  });

  it('retries temporary errors with backoff, then succeeds', async () => {
    const fake = fakeAdapter();
    fake.queue.push('temporary', 'temporary');
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Retry me', channelIds: [s.channelId], action: 'now' });
    await tick('test');
    let t = await target(id);
    assert.equal(t.status, 'retrying');
    assert.equal(t.error_code, 'server_error');
    assert.ok(t.next_attempt_at.getTime() > Date.now() + 50_000, 'first retry waits about a minute');
    await tick('test', later(2 * MIN));
    t = await target(id);
    assert.equal(t.status, 'retrying');
    await tick('test', later(8 * MIN));
    t = await target(id);
    assert.equal(t.status, 'published');
    assert.equal(t.attempts, 3);
    assert.equal(fake.published.length, 1);
  });

  it('fails permanently on a permanent error, raises an alert and emails it', async () => {
    const fake = fakeAdapter();
    fake.queue.push('permanent');
    const s = await seed();
    const before = outbox().length;
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Bad media', channelIds: [s.channelId], action: 'now' });
    await tick('test');
    const t = await target(id);
    assert.equal(t.status, 'failed');
    assert.match(t.error_message, /media rejected/);
    assert.equal(t.error_hint, 'Edit the post.');
    const alerts = await all('SELECT * FROM alerts WHERE workspace_id = ? AND resolved_at IS NULL', [s.wsId]);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'post_failed');
    assert.ok(alerts[0].emailed_at, 'alert was emailed');
    assert.ok(outbox().slice(before).some((m) => /did not go out/.test(m.subject)));
    assert.equal((await one('SELECT status FROM posts WHERE id = ?', [id]))!.status, 'failed');
  });

  it('gives up after the last retry', async () => {
    const fake = fakeAdapter();
    fake.queue.push(...Array(6).fill('temporary'));
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Doomed', channelIds: [s.channelId], action: 'now' });
    for (const m of [0, 2, 7, 25, 60, 106]) await tick('test', later(m * MIN));
    const t = await target(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.attempts, 6);
    assert.match(t.error_message, /Gave up after 6 attempts/);
  });

  it('disconnects the channel on an auth error and publishes once it is reconnected', async () => {
    const fake = fakeAdapter();
    fake.queue.push('auth');
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Needs a token', channelIds: [s.channelId], action: 'now' });
    await tick('test');
    assert.equal((await one('SELECT status FROM channels WHERE id = ?', [s.channelId]))!.status, 'disconnected');
    assert.equal((await target(id)).status, 'retrying');
    const alert = await one("SELECT * FROM alerts WHERE kind = 'channel_disconnected'");
    assert.ok(alert);
    // While disconnected the engine waits instead of calling the platform.
    await tick('test', later(11 * MIN));
    assert.equal(fake.published.length, 0);
    assert.equal((await target(id)).error_code, 'channel_disconnected');
    // Reconnect.
    await run("UPDATE channels SET status = 'ok' WHERE id = ?", [s.channelId]);
    await tick('test', later(22 * MIN));
    assert.equal((await target(id)).status, 'published');
  });

  it('never publishes the same target twice when two ticks race', async () => {
    const fake = fakeAdapter();
    fake.queue.push('hang');
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Only once', channelIds: [s.channelId], action: 'now' });
    const t = await target(id);
    const results = await Promise.all([publishTarget(t.id), publishTarget(t.id), publishTarget(t.id)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(fake.published.length, 1);
  });

  it('flags an interrupted publish instead of risking a duplicate', async () => {
    fakeAdapter();
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Crash', channelIds: [s.channelId], action: 'now' });
    await run("UPDATE post_targets SET status = 'publishing', locked_until = ? WHERE post_id = ?", [new Date(Date.now() - MIN), id]);
    await tick('test');
    const t = await target(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.error_code, 'interrupted');
  });

  it('holds a post whose slot passed long ago instead of posting it late', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Old news', channelIds: [s.channelId], action: 'schedule', scheduledAt: new Date(Date.now() + MIN).toISOString() });
    await tick('test', later(4 * 60 * MIN));
    const t = await target(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.error_code, 'missed_slot');
    assert.equal(fake.published.length, 0);
  });

  it('waits for client approval, then publishes', async () => {
    const fake = fakeAdapter();
    const s = await seed({ approval: true });
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Approve me', channelIds: [s.channelId], action: 'schedule', scheduledAt: new Date(Date.now() + 30 * MIN).toISOString() });
    assert.equal((await one('SELECT status FROM posts WHERE id = ?', [id]))!.status, 'awaiting_approval');
    assert.ok(outbox().some((m) => m.to === 'client@example.com' && /approval/.test(m.subject)));
    await tick('test', later(10 * MIN));
    assert.equal(fake.published.length, 0);
    await decideApproval(id, s.clientId, 'approved', 'Jo', '');
    await tick('test', later(31 * MIN));
    assert.equal((await target(id)).status, 'published');
  });

  it('warns before the slot when the channel check fails', async () => {
    const fake = fakeAdapter();
    fake.setCheck('auth');
    const s = await seed();
    await run('UPDATE channels SET last_checked_at = ? WHERE id = ?', [new Date(Date.now() - 60 * MIN), s.channelId]);
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Soon', channelIds: [s.channelId], action: 'schedule', scheduledAt: new Date(Date.now() + 10 * MIN).toISOString() });
    await tick('test');
    const t = await target(id);
    assert.equal(t.preflight_ok, 0);
    assert.match(t.preflight_message, /connection failed its check/);
    const kinds = (await all('SELECT kind FROM alerts WHERE resolved_at IS NULL')).map((a) => a.kind).sort();
    assert.deepEqual(kinds, ['channel_disconnected', 'preflight_failed']);
  });

  it('rejects posts that break a platform limit', async () => {
    fakeAdapter();
    const s = await seed();
    await assert.rejects(savePost(s.wsId, s.user, { clientId: s.clientId, body: 'x'.repeat(301), channelIds: [s.channelId], action: 'now' }), /cannot take this post/);
    // Drafts are allowed to be over the limit while you work on them.
    await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'x'.repeat(301), channelIds: [s.channelId], action: 'draft' });
  });

  it('editing a scheduled post keeps its time', async () => {
    fakeAdapter();
    const s = await seed();
    const when = new Date(Date.now() + 120 * MIN);
    when.setMilliseconds(0);
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'v1', channelIds: [s.channelId], action: 'schedule', scheduledAt: when.toISOString() });
    await savePost(s.wsId, s.user, { body: 'v2', channelIds: [s.channelId], action: 'schedule', scheduledAt: when.toISOString() }, id);
    const p = (await one('SELECT * FROM posts WHERE id = ?', [id]))!;
    assert.equal(p.body, 'v2');
    assert.equal(p.scheduled_at.getTime(), when.getTime());
  });
});
