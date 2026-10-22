import './env.js';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { config } from '../src/config.js';
import { closeDb, run } from '../src/db.js';
import { adaptPost, aiUsage, altText, editPost, learnVoice, overrideAiModel, suggestHashtags, writePosts, type AiCall } from '../src/engine/ai.js';
import { newId, token } from '../src/util.js';
import { resetDb, seed } from './helpers.js';

/** A fake model: each task answers with whatever the test sets, and every call is recorded. */
function fakeModel(answers: Record<string, (c: AiCall, n: number) => unknown>) {
  const calls: AiCall[] = [];
  overrideAiModel(async (c) => {
    calls.push(c);
    const n = calls.filter((x) => x.task === c.task).length;
    return { data: answers[c.task](c, n), inputTokens: 100, outputTokens: 50 };
  });
  return calls;
}

const promptText = (c: AiCall) => c.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');

describe('AI writing assistant', () => {
  beforeEach(async () => {
    await resetDb();
    overrideAiModel(null);
    config.ai.dailyLimit = 300;
  });
  after(async () => {
    overrideAiModel(null);
    await closeDb();
  });

  it('is switched off without an API key', async () => {
    const s = await seed();
    config.ai.apiKey = '';
    assert.equal((await aiUsage(s.wsId)).enabled, false);
    await assert.rejects(writePosts(s.wsId, { brief: 'Croissants' }), /switched off/);
  });

  it("writes posts in the client's saved voice and flags any that are too long", async () => {
    const s = await seed();
    await run('UPDATE clients SET voice = ? WHERE id = ?', [JSON.stringify({ description: 'Cheerful and local', donts: 'Never say "artisanal"' }), s.clientId]);
    const calls = fakeModel({ write: () => ({ posts: [{ text: 'Fresh croissants at 7am!', angle: 'early' }, { text: 'x'.repeat(320), angle: 'long' }] }) });
    const r = await writePosts(s.wsId, { clientId: s.clientId, brief: 'New croissants every morning', platforms: ['bluesky'], count: 2 });
    assert.deepEqual(r.posts.map((p) => p.fits), [true, false]);
    assert.match(calls[0].system, /Cheerful and local/);
    assert.match(calls[0].system, /Never: Never say "artisanal"/);
    assert.match(promptText(calls[0]), /under 300 characters/);
    assert.match(promptText(calls[0]), /<brief>\nNew croissants every morning\n<\/brief>/);
  });

  it('adapts a post per network and retries the ones that come back too long', async () => {
    const s = await seed();
    const calls = fakeModel({
      adapt: (c, n) =>
        n === 1
          ? { versions: [{ platform: 'x', text: 'y'.repeat(400) }, { platform: 'linkedin', text: 'A longer LinkedIn post.' }] }
          : { versions: [{ platform: 'x', text: 'Short for X.' }] },
    });
    const r = await adaptPost(s.wsId, { clientId: s.clientId, text: 'Our new bakery opens Monday.', platforms: ['x', 'linkedin', 'nope'] });
    assert.equal(calls.length, 2);
    assert.match(promptText(calls[1]), /- x:/);
    assert.doesNotMatch(promptText(calls[1]), /- linkedin:/);
    assert.deepEqual(
      r.versions.map((v) => [v.platform, v.text, v.fits]),
      [
        ['x', 'Short for X.', true],
        ['linkedin', 'A longer LinkedIn post.', true],
      ],
    );
  });

  it('cleans up hashtag suggestions and skips ones already in the post', async () => {
    const s = await seed();
    fakeModel({ hashtags: () => ({ hashtags: ['#Bakery', 'fresh bread', '##Croissant', '#bakery', 'Pune!'] }) });
    const r = await suggestHashtags(s.wsId, { text: 'Hot bread today #Bakery', count: 5 });
    assert.deepEqual(r.hashtags, ['#freshbread', '#Croissant', '#Pune']);
  });

  it('sends the image itself when writing alt text', async () => {
    const s = await seed();
    const mediaId = newId('med');
    await run('INSERT INTO media (id, workspace_id, filename, mime, size, public_key, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [mediaId, s.wsId, 'a.png', 'image/png', 3, token(12), Buffer.from('abc'), new Date()]);
    const calls = fakeModel({ alt: () => ({ alt: ' A tray of golden croissants. ' }) });
    assert.deepEqual(await altText(s.wsId, { mediaId }), { alt: 'A tray of golden croissants.' });
    const img = calls[0].content[0];
    assert.equal(img.type, 'image');
    await assert.rejects(altText('wsp_other', { mediaId }), /not found/);
  });

  it('stops at the daily limit for the workspace', async () => {
    const s = await seed();
    config.ai.dailyLimit = 2;
    fakeModel({ edit: () => ({ text: 'Shorter.' }) });
    await editPost(s.wsId, { text: 'A long post', action: 'shorter' });
    await editPost(s.wsId, { text: 'A long post', action: 'shorter' });
    await assert.rejects(editPost(s.wsId, { text: 'A long post', action: 'shorter' }), /used today's 2/);
    assert.equal((await aiUsage(s.wsId)).usedToday, 2);
  });

  it('learns a voice only from enough of the client’s own posts', async () => {
    const s = await seed();
    fakeModel({ voice: () => ({ description: 'Warm', audience: 'Locals', dos: 'Mention the neighbourhood', donts: 'No jargon', examples: ['One', 'Two', 'Three', 'Four'], language: 'English' }) });
    await assert.rejects(learnVoice(s.wsId, s.clientId), /at least 3 posts/);
    for (let i = 0; i < 3; i++)
      await run("INSERT INTO posts (id, workspace_id, client_id, author_id, body, media_ids, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', 'published', ?, ?)", [
        newId('pst'),
        s.wsId,
        s.clientId,
        s.userId,
        `Post ${i}`,
        new Date(),
        new Date(),
      ]);
    const { voice } = await learnVoice(s.wsId, s.clientId);
    assert.equal(voice.description, 'Warm');
    assert.equal(voice.examples, 'One\n---\nTwo\n---\nThree');
  });
});
