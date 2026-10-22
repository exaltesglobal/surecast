import './env.js';

import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../src/config.js';
import { closeDb, run } from '../src/db.js';
import { collectReviews, listInbox, replyToItem } from '../src/engine/inbox.js';
import { reviewText } from '../src/platforms/google.js';
import { encrypt } from '../src/util.js';
import { resetDb, seed } from './helpers.js';

const realFetch = globalThis.fetch;

describe('wave 10: Google reviews in the inbox', () => {
  beforeEach(async () => {
    await resetDb();
    config.google ??= { id: 'gid', secret: 'gsecret' };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(closeDb);

  it('keeps only the original text of a translated review', () => {
    assert.equal(reviewText('Great coffee\n\n(Translated by Google)\nGroßartiger Kaffee'), 'Great coffee');
    assert.equal(reviewText('(Translated by Google) Great coffee\n\n(Original)\nGroßartiger Kaffee'), 'Großartiger Kaffee');
    assert.equal(reviewText(undefined), '');
  });

  it('brings in reviews, marks answered ones done, and replies on Google', async () => {
    const s = await seed({ platform: 'google' });
    await run('UPDATE channels SET credentials = ?, token_expires_at = ? WHERE id = ?', [
      encrypt({ accessToken: 't', refreshToken: 'r', account: 'accounts/1', location: 'locations/9' }),
      new Date(Date.now() + 3_600_000),
      s.channelId,
    ]);
    const base = 'https://mybusiness.googleapis.com/v4/accounts/1/locations/9/reviews';
    let reviews = [
      { name: 'accounts/1/locations/9/reviews/a', reviewId: 'a', reviewer: { displayName: 'Priya' }, starRating: 'TWO', comment: 'Cold food.', createTime: '2026-10-20T10:00:00Z' },
      {
        name: 'accounts/1/locations/9/reviews/b',
        reviewId: 'b',
        reviewer: { isAnonymous: true },
        starRating: 'FIVE',
        createTime: '2026-10-19T10:00:00Z',
        reviewReply: { comment: 'Thank you!', updateTime: '2026-10-19T12:00:00Z' },
      },
    ] as any[];
    const puts: { url: string; body: any }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.startsWith(base) && (init.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ reviews }), { headers: { 'Content-Type': 'application/json' } });
      if (init.method === 'PUT') {
        puts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ comment: 'ok' }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 500 });
    }) as typeof fetch;

    assert.equal(await collectReviews(), 2);
    const { items, open } = await listInbox(s.wsId, {});
    assert.equal(open, 1);
    const priya = items.find((i) => i.author.name === 'Priya')!;
    assert.equal(priya.isReview, true);
    assert.equal(priya.rating, 2);
    assert.equal(priya.status, 'open');
    const anon = items.find((i) => i.author.name === 'A Google user')!;
    assert.equal(anon.status, 'done');
    assert.equal(anon.reply?.text, 'Thank you!');

    // Checked again only after 30 minutes, and nothing is duplicated.
    assert.equal(await collectReviews(), 0);
    await run('UPDATE channels SET reviews_checked_at = NULL');
    assert.equal(await collectReviews(), 0);

    const replied = await replyToItem(s.wsId, s.user, priya.id, 'Sorry, Priya. Please call us so we can put it right.');
    assert.equal(replied!.status, 'done');
    assert.deepEqual(puts, [{ url: `${base}/a/reply`, body: { comment: 'Sorry, Priya. Please call us so we can put it right.' } }]);

    // Answered on Google directly: the next check marks it done.
    reviews = [{ ...reviews[0], name: 'accounts/1/locations/9/reviews/c', reviewId: 'c', reviewer: { displayName: 'Ravi' } }];
    await run('UPDATE channels SET reviews_checked_at = NULL');
    await collectReviews();
    reviews[0].reviewReply = { comment: 'Answered in Google', updateTime: '2026-10-21T09:00:00Z' };
    await run('UPDATE channels SET reviews_checked_at = NULL');
    await collectReviews();
    const ravi = (await listInbox(s.wsId, {})).items.find((i) => i.author.name === 'Ravi')!;
    assert.equal(ravi.status, 'done');
    assert.equal(ravi.reply?.text, 'Answered in Google');
  });
});
