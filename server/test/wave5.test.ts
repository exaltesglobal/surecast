import './env.js';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { closeDb, one, run } from '../src/db.js';
import { overrideAiModel, suggestReplies } from '../src/engine/ai.js';
import { collectInbox, listInbox, replyToItem, setStatus } from '../src/engine/inbox.js';
import { savePost } from '../src/engine/posts.js';
import { tick } from '../src/engine/publisher.js';
import { pinParts } from '../src/platforms/pinterest.js';
import { hashSecret, newId } from '../src/util.js';
import { fakeAdapter, resetDb, seed } from './helpers.js';

const comment = (id: string, parentId: string, text: string, who = 'Priya') => ({ id, parentId, authorName: who, authorHandle: `@${who.toLowerCase()}`, authorAvatar: null, text, createdAt: new Date(), url: null });

async function publishedWithComments() {
  const fake = fakeAdapter();
  const s = await seed();
  await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Pumpkin croissants are back', channelIds: [s.channelId], action: 'now' });
  await tick('test');
  // The tick may already have looked for comments (there were none yet); look again from scratch.
  await run('UPDATE post_targets SET inbox_checked_at = NULL');
  fake.inbox.r1 = [comment('k1', 'r1', 'Are they vegan?'), comment('k2', 'k1', 'Asking too!', 'Sam')];
  return { fake, s };
}

describe('inbox, MCP server and new networks', () => {
  beforeEach(resetDb);
  after(() => {
    overrideAiModel(null);
    return closeDb();
  });

  it('collects comments from every published post once, newest first', async () => {
    const { fake, s } = await publishedWithComments();
    assert.equal(await collectInbox(), 2);
    // Checked again later: the same comments are not added twice, new ones are.
    fake.inbox.r1.push(comment('k3', 'r1', 'Love these'));
    assert.equal(await collectInbox(new Date(Date.now() + 11 * 60_000)), 1);
    const r = await listInbox(s.wsId, { status: 'open' });
    assert.equal(r.open, 3);
    assert.equal(r.items.length, 3);
    const k2 = r.items.find((i) => i.text === 'Asking too!')!;
    assert.equal(k2.isReplyToComment, true);
    assert.equal(k2.postText, 'Pumpkin croissants are back');
  });

  it('replies under the comment, records who answered, and keeps errors visible', async () => {
    const { fake, s } = await publishedWithComments();
    await collectInbox();
    const item = (await listInbox(s.wsId, {})).items.find((i) => i.text === 'Are they vegan?')!;
    await assert.rejects(replyToItem(s.wsId, s.user, item.id, '   '), /Write a reply/);
    fake.replyQueue.push('permanent');
    await assert.rejects(replyToItem(s.wsId, s.user, item.id, 'Yes!'), /did not accept the reply/);
    assert.match((await one('SELECT reply_error FROM inbox_items WHERE id = ?', [item.id]))!.reply_error, /400/);
    const done = await replyToItem(s.wsId, s.user, item.id, 'Yes, fully vegan 🌱');
    assert.equal(done!.status, 'done');
    assert.equal(done!.reply!.by, 'Owner');
    assert.deepEqual(fake.replies.at(-1), { parentId: 'k1', rootId: 'r1', text: 'Yes, fully vegan 🌱' });
    assert.equal((await listInbox(s.wsId, { status: 'open' })).open, 1);
    await setStatus(s.wsId, [(await listInbox(s.wsId, { status: 'open' })).items[0].id], 'done');
    assert.equal((await listInbox(s.wsId, { status: 'open' })).open, 0);
  });

  it('suggests replies in the client’s voice', async () => {
    const { s } = await publishedWithComments();
    await collectInbox();
    const item = (await listInbox(s.wsId, {})).items[0];
    let prompt = '';
    overrideAiModel(async (c) => {
      prompt = JSON.stringify(c.content);
      return { data: { replies: ['Thank you!', 'Yes they are', 'Come try one', 'extra'] }, inputTokens: 10, outputTokens: 10 };
    });
    const r = await suggestReplies(s.wsId, item.id);
    assert.equal(r.replies.length, 3);
    assert.match(prompt, /Pumpkin croissants are back/);
    assert.match(prompt, new RegExp(item.text));
  });

  it('serves MCP tools to agents with a workspace API key', async () => {
    fakeAdapter();
    const s = await seed();
    const key = 'sc_live_testkeytestkeytestkey';
    await run('INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [newId('key'), s.wsId, 'Agent', 'sc_live_test', hashSecret(key), s.userId, new Date()]);
    const app = createApp();
    const rpc = async (body: unknown, path = '/mcp', auth = true) => {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: res.status === 202 ? null : await res.json() };
    };
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, '/mcp', false)).status, 401);
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.json.result.protocolVersion, '2025-03-26');
    assert.equal(init.json.result.serverInfo.name, 'surecast');
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
    const tools = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, '/v1/mcp');
    assert.ok(tools.json.result.tools.some((t: { name: string }) => t.name === 'create_post'));
    const clients = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_clients', arguments: {} } });
    assert.equal(clients.json.result.structuredContent.items[0].channels[0].id, s.channelId);
    const created = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_post', arguments: { client_id: s.clientId, text: 'Hello from an agent', when: 'now' } } });
    assert.equal(created.json.result.isError, false);
    assert.equal(created.json.result.structuredContent.channels[0].status, 'scheduled');
    assert.equal((await one('SELECT source FROM posts'))!.source, 'api');
    const tooLong = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_post', arguments: { client_id: s.clientId, text: 'x'.repeat(400), when: 'now' } } });
    assert.equal(tooLong.json.result.isError, true);
    assert.match(tooLong.json.result.content[0].text, /cannot take this post/);
    const unknown = await rpc({ jsonrpc: '2.0', id: 6, method: 'nope' });
    assert.equal(unknown.json.error.code, -32601);
  });

  it('splits Pinterest text into a title, description and link', () => {
    assert.deepEqual(pinParts('Autumn menu is here\nPumpkin croissants and chai. https://acme.example/menu'), {
      title: 'Autumn menu is here',
      description: 'Pumpkin croissants and chai. https://acme.example/menu',
      link: 'https://acme.example/menu',
    });
    assert.equal(pinParts('Just one line https://a.example').title, 'Just one line');
  });
});
