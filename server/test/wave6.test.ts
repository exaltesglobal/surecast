import './env.js';

import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';

import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { all, closeDb, one, run } from '../src/db.js';
import { overrideAiModel, pageText, suggestReplies } from '../src/engine/ai.js';
import { autoResume, pauseClient, resumeClient } from '../src/engine/brake.js';
import { connectChitthi, overrideChitthi, receiveHook, whatsappAlerts } from '../src/engine/chitthi.js';
import { digestFor, sendDigests } from '../src/engine/digest.js';
import { guardIssues } from '../src/engine/guard.js';
import { listInbox, replyToItem } from '../src/engine/inbox.js';
import { addMoment, builtInMoments, easter, listMoments } from '../src/engine/moments.js';
import { savePost, validateDraft } from '../src/engine/posts.js';
import { publishTarget, tick } from '../src/engine/publisher.js';
import { outbox } from '../src/mail.js';
import { generateApiKey } from '../src/auth.js';
import { hashSecret, hmac, newId } from '../src/util.js';
import { fakeAdapter, resetDb, seed, target } from './helpers.js';

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

/** A fake Chitthi: records requests and answers what the test queues. */
function fakeChitthi() {
  const calls: { method: string; path: string; body: any; auth: string }[] = [];
  const answers: { status: number; body: any }[] = [];
  overrideChitthi(async (url, init) => {
    const path = url.replace(config.chitthiUrl, '');
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    const queued = answers.shift();
    if (queued) return queued;
    if (init.method === 'GET' && path === '/api/integrations/hooks') return { status: 200, body: { workspace: 'Acme on Chitthi', hooks: [] } };
    if (init.method === 'POST' && path === '/api/integrations/hooks') return { status: 201, body: { id: 'hook_1', secret: 'whsec_test' } };
    return { status: 201, body: { id: 'm1', wa_message_id: 'wamid.1', conversation_id: 'c1' } };
  });
  return { calls, answers };
}

const signed = (body: string, secret = 'whsec_test', t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${hmac(secret, `${t}.${body}`)}`;

describe('wave 6: emergency brake, brand guard, WhatsApp, moments, digest, admin, API', () => {
  beforeEach(resetDb);
  after(() => {
    overrideAiModel(null);
    overrideChitthi(null);
    return closeDb();
  });

  it('pauses a client: nothing goes out, new posts are held, and resume keeps future times', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    const soon = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Soon', channelIds: [s.channelId], action: 'schedule', scheduledAt: inHours(2) });
    const r = await pauseClient(s.wsId, s.clientId, { reason: 'Crisis', by: 'Owner' }, s.user);
    assert.equal(r.held, 1);
    assert.equal((await target(soon)).status, 'paused');
    assert.equal((await one('SELECT status FROM posts WHERE id = ?', [soon]))!.status, 'paused');
    // A post made while paused is held straight away, even "post now".
    const now = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Now', channelIds: [s.channelId], action: 'now' });
    assert.equal((await target(now)).status, 'paused');
    await tick('test', () => new Date(Date.now() + 3 * HOUR));
    assert.equal(fake.published.length, 0);
    // The watchdog leaves paused posts alone.
    assert.equal((await target(soon)).status, 'paused');
    const alert = await one("SELECT * FROM alerts WHERE kind = 'client_paused' AND resolved_at IS NULL");
    assert.match(alert!.title, /paused/);

    const back = await resumeClient(s.wsId, s.clientId, 'skip', s.user);
    assert.deepEqual({ resumed: back.resumed, skipped: back.skipped }, { resumed: 1, skipped: 1 });
    assert.equal((await target(soon)).status, 'scheduled');
    assert.equal((await target(now)).status, 'cancelled');
    assert.equal((await one("SELECT resolved_at FROM alerts WHERE kind = 'client_paused'"))!.resolved_at instanceof Date, true);
  });

  it('a target already due when the brake goes on is held at publish time, and resumes as "post now" or into the queue', async () => {
    const fake = fakeAdapter();
    const s = await seed();
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Due', channelIds: [s.channelId], action: 'now' });
    await run('UPDATE clients SET paused_at = ? WHERE id = ?', [new Date(), s.clientId]);
    const t = await target(id);
    assert.equal(await publishTarget(t.id), false);
    assert.equal((await target(id)).status, 'paused');
    const r = await resumeClient(s.wsId, s.clientId, 'post_now', s.user);
    assert.equal(r.postedNow, 1);
    await tick('test');
    assert.equal(fake.published.length, 1);

    // Queue mode moves missed posts into the client's next posting times.
    await run('UPDATE clients SET queue_slots = ? WHERE id = ?', [JSON.stringify([{ day: 1, time: '09:00' }, { day: 4, time: '09:00' }]), s.clientId]);
    const a = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'A', channelIds: [s.channelId], action: 'schedule', scheduledAt: inHours(1) });
    const b = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'B', channelIds: [s.channelId], action: 'schedule', scheduledAt: inHours(1.5) });
    await pauseClient(s.wsId, s.clientId, { reason: 'Hold', missed: 'queue', until: inHours(1.8), by: 'Owner' }, s.user);
    assert.equal(await autoResume(new Date(Date.now() + HOUR)), 0);
    assert.equal(await autoResume(new Date(Date.now() + 2 * HOUR)), 1);
    const [ta, tb] = [await target(a), await target(b)];
    assert.equal(ta.status, 'scheduled');
    assert.notEqual(ta.due_at.getTime(), tb.due_at.getTime());
    assert.ok(ta.due_at.getTime() > Date.now() + HOUR);
    assert.equal((await one('SELECT paused_at FROM clients WHERE id = ?', [s.clientId]))!.paused_at, null);
  });

  it('the brand guard matches whole words, blocks or warns, and stops a post at publish time', async () => {
    const guard = { banned: ['ass', 'Brand X', '#ad-free'], required: ['#ad'], mode: 'block' as const };
    assert.deepEqual(guardIssues(guard, 'Join our class today #ad'), []);
    assert.equal(guardIssues(guard, 'Better than brand x! #ad').length, 1);
    assert.match(guardIssues(guard, 'No disclosure here')[0], /Missing a line/);

    const fake = fakeAdapter();
    const s = await seed();
    await run('UPDATE clients SET guard = ? WHERE id = ?', [JSON.stringify(guard), s.clientId]);
    await assert.rejects(savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Better than Brand X', channelIds: [s.channelId], action: 'now' }), /cannot take this post/);
    await run('UPDATE clients SET guard = ? WHERE id = ?', [JSON.stringify({ ...guard, mode: 'warn' }), s.clientId]);
    const report = await validateDraft(s.wsId, { body: 'Better than Brand X', channelIds: [s.channelId] });
    assert.deepEqual(report[0].issues, []);
    assert.equal(report[0].warnings.length, 2);
    // Scheduled under "warn", then the agency switches to "block": it is stopped, not published.
    const id = await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Better than Brand X', channelIds: [s.channelId], action: 'now' });
    await run('UPDATE clients SET guard = ? WHERE id = ?', [JSON.stringify(guard), s.clientId]);
    await tick('test');
    const t = await target(id);
    assert.equal(t.status, 'failed');
    assert.equal(t.error_code, 'brand_guard');
    assert.equal(fake.published.length, 0);
  });

  it('Chitthi: approval requests reach the client on WhatsApp, falling back to a template outside the 24-hour window', async () => {
    fakeAdapter();
    const wa = fakeChitthi();
    const s = await seed({ approval: true });
    await assert.rejects(connectChitthi(s.wsId, null, 'not-a-key'), /chk_live_/);
    const integ = await connectChitthi(s.wsId, null, 'chk_live_agencykey123', { alertPhones: '+91 98765 43210', approvalTemplate: { name: 'post_approval', language: 'en' } });
    assert.equal(integ!.account, 'Acme on Chitthi');
    assert.deepEqual(integ!.settings!.alertPhones, ['+919876543210']);
    await run('UPDATE clients SET whatsapp_phone = ? WHERE id = ?', ['+919800000001', s.clientId]);
    wa.calls.length = 0;
    wa.answers.push({ status: 409, body: { error: 'The 24-hour customer-service window is closed for this contact. Send a template instead.' } });
    await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Diwali offer', channelIds: [s.channelId], action: 'schedule', scheduledAt: inHours(5) });
    assert.equal(wa.calls.length, 2);
    assert.equal(wa.calls[0].body.text.includes('/c/'), true);
    assert.equal(wa.calls[1].body.template, 'post_approval');
    assert.equal(wa.calls[1].body.params[0], 'Acme Bakery');
    assert.equal(wa.calls[1].auth, 'Bearer chk_live_agencykey123');
    // The email still goes too.
    assert.match(outbox().at(-1)!.subject, /ready for your approval/);
  });

  it('Chitthi: failed posts alert the agency on WhatsApp once', async () => {
    const fake = fakeAdapter();
    const wa = fakeChitthi();
    const s = await seed();
    await connectChitthi(s.wsId, null, 'chk_live_agencykey123', { alertPhones: ['+919876543210'] });
    fake.queue.push('permanent');
    await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Hello', channelIds: [s.channelId], action: 'now' });
    wa.calls.length = 0;
    await tick('test');
    const sent = wa.calls.filter((c) => c.path === '/api/v1/messages');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.to, '+919876543210');
    assert.match(sent[0].body.text, /did not go out/);
    assert.equal(await whatsappAlerts(), 0);
  });

  it('Chitthi: a client’s WhatsApp messages land in the inbox, signed, and replies go back', async () => {
    fakeAdapter();
    const wa = fakeChitthi();
    const s = await seed();
    const integ = await connectChitthi(s.wsId, s.clientId, 'chk_live_clientkey123');
    assert.equal(integ!.inbox, true);
    const hook = wa.calls.find((c) => c.method === 'POST' && c.path === '/api/integrations/hooks')!;
    assert.equal(hook.body.event, 'message.received');
    const token = hook.body.target_url.split('/').pop();
    const event = JSON.stringify({ id: 'evt_1', event: 'message.received', data: { contact: { id: 'ct1', phone: '+919811112222', name: 'Meera' }, conversation_id: 'cv1', wa_message_id: 'wamid.A', type: 'text', text: 'Do you deliver to Baner?' } });

    const app = createApp();
    const post = (sig: string) => app.request(`/v1/hooks/chitthi/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Chitthi-Signature': sig }, body: event });
    assert.equal((await post('t=1,v1=bad')).status, 401);
    assert.equal((await post(signed(event))).status, 200);
    assert.equal((await post(signed(event))).status, 200); // a redelivery is not stored twice
    await assert.rejects(receiveHook(token, event, signed(event, 'wrong')), /Bad signature/);

    const inbox = await listInbox(s.wsId, { status: 'open' });
    assert.equal(inbox.items.length, 1);
    const item = inbox.items[0];
    assert.equal(item.platform, 'whatsapp');
    assert.equal(item.isDirect, true);
    assert.equal(item.author.name, 'Meera');
    assert.equal(item.channelName, 'Acme on Chitthi');

    let prompt = '';
    overrideAiModel(async (c) => {
      prompt = JSON.stringify(c.content);
      return { data: { replies: ['Yes we do!', 'We deliver across Pune', 'Let me check'] }, inputTokens: 1, outputTokens: 1 };
    });
    assert.equal((await suggestReplies(s.wsId, item.id)).replies.length, 3);
    assert.match(prompt, /Baner/);

    wa.answers.push({ status: 409, body: { error: 'window closed' } });
    await assert.rejects(replyToItem(s.wsId, s.user, item.id, 'Yes!'), /24 hours/);
    const done = await replyToItem(s.wsId, s.user, item.id, 'Yes, we deliver to Baner every day.');
    assert.equal(done!.status, 'done');
    assert.deepEqual(wa.calls.at(-1)!.body, { to: '+919811112222', text: 'Yes, we deliver to Baner every day.' });
    assert.equal(wa.calls.at(-1)!.auth, 'Bearer chk_live_clientkey123');
  });

  it('computes moments for any year and repeats the agency’s own yearly dates', async () => {
    assert.equal(easter(2026).toISOString().slice(0, 10), '2026-04-05');
    assert.equal(easter(2027).toISOString().slice(0, 10), '2027-03-28');
    const m = builtInMoments('2026-01-01', '2026-12-31');
    const date = (name: string) => m.find((x) => x.name === name)!.date;
    assert.equal(date("Mother's Day"), '2026-05-10');
    assert.equal(date("Father's Day"), '2026-06-21');
    assert.equal(date('Thanksgiving'), '2026-11-26');
    assert.equal(date('Black Friday'), '2026-11-27');
    assert.equal(date('Cyber Monday'), '2026-11-30');
    assert.equal(date('Memorial Day'), '2026-05-25');
    assert.equal(m.find((x) => x.name === 'Diwali')!.approximate, true);
    assert.ok(builtInMoments('2026-01-01', '2026-12-31', ['us']).every((x) => x.region === 'us'));

    const s = await seed();
    await addMoment(s.wsId, { date: '2024-03-15', name: 'Acme anniversary', yearly: true, clientId: s.clientId });
    const r = await listMoments(s.wsId, { from: '2026-03-01', to: '2027-03-31' });
    assert.deepEqual(r.moments.filter((x) => x.kind === 'custom').map((x) => x.date), ['2026-03-15', '2027-03-15']);
    await assert.rejects(listMoments(s.wsId, { from: '2026-01-01', to: '2028-01-01' }), /at most a year/);
  });

  it('sends each client one weekly digest on Monday morning in their own time zone', async () => {
    fakeAdapter();
    const s = await seed();
    await run("UPDATE clients SET digest_enabled = 1, timezone = 'Asia/Kolkata' WHERE id = ?", [s.clientId]);
    await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Published one', channelIds: [s.channelId], action: 'now' });
    await tick('test');
    await savePost(s.wsId, s.user, { clientId: s.clientId, body: 'Next week one', channelIds: [s.channelId], action: 'schedule', scheduledAt: inHours(30) });
    const d = await digestFor({ id: s.clientId, name: 'Acme Bakery', timezone: 'Asia/Kolkata', share_token: 'tok' });
    assert.equal(d.counts.published, 1);
    assert.equal(d.counts.upcoming, 1);
    assert.match(d.lines.join('\n'), /Next week one/);

    // Find the next Monday 09:30 in India (04:00 UTC).
    const monday = new Date();
    monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
    monday.setUTCHours(4, 0, 0, 0);
    const before = outbox().length;
    assert.equal(await sendDigests(new Date(monday.getTime() - 2 * HOUR)), 0); // 07:30 local: too early
    assert.equal(await sendDigests(monday), 1);
    assert.equal(await sendDigests(new Date(monday.getTime() + HOUR)), 0);
    assert.equal(outbox().length, before + 1);
    assert.match(outbox().at(-1)!.subject, /your week on social media/);
  });

  it('reads the useful text out of a web page for campaigns', () => {
    const p = pageText(
      '<html><head><title>Ignored</title><meta property="og:title" content="Pumpkin Spice Croissant &amp; More"><meta name="description" content="Back for autumn."></head>' +
        '<body><nav>Home | Shop</nav><main><h1>Pumpkin croissant</h1><p>Baked fresh daily at 7am.</p><script>track()</script></main><footer>© Acme</footer></body></html>',
    );
    assert.equal(p.title, 'Pumpkin Spice Croissant & More');
    assert.equal(p.description, 'Back for autumn.');
    assert.match(p.text, /Baked fresh daily at 7am/);
    assert.doesNotMatch(p.text, /track\(\)|Home \| Shop|Acme/);
  });

  it('admin panel: hidden from customers, roles decide what staff can do, every change is audited', async () => {
    fakeAdapter();
    const app = createApp();
    const jar = new Map<string, string>();
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/v1${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const c of res.headers.getSetCookie()) {
        const [pair, ...attrs] = c.split(';');
        const [k, v] = pair.split('=');
        if (!v || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(k);
        else jar.set(k, v);
      }
      return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
    };
    const signIn = async (email: string) => {
      jar.clear();
      await api('POST', '/auth/code', { email });
      const code = outbox().at(-1)!.subject.match(/(\d{6})/)![1];
      assert.equal((await api('POST', '/auth/verify', { email, code, name: email.split('@')[0] })).status, 200);
    };

    // A customer with one client and a scheduled post.
    await signIn('owner@agency.example');
    const ws = (await api('GET', '/me')).data.workspaceId;
    assert.equal((await api('GET', '/workspace')).data.workspace.plan.id, 'trial');
    const client = (await api('POST', '/clients', { name: 'Acme' })).data.id;
    const ch = (await api('POST', '/channels/connect', { clientId: client, platform: 'bluesky', values: { handle: 'acme' } })).data.channelId;
    assert.equal((await api('POST', '/posts', { clientId: client, body: 'Later', channelIds: [ch], action: 'schedule', scheduledAt: inHours(4) })).status, 201);
    assert.equal((await api('GET', '/admin/overview')).status, 404);
    assert.equal((await api('GET', '/me')).data.staffRole, null);

    // Support can look and view as the customer, but cannot suspend.
    await signIn('sam@surecast.live');
    const sam = await one<{ id: string }>('SELECT id FROM users WHERE email = ?', ['sam@surecast.live']);
    await run("INSERT INTO staff (user_id, role, created_at) VALUES (?, 'support', ?)", [sam!.id, new Date()]);
    assert.equal((await api('GET', '/me')).data.staffRole, 'support');
    const list = await api('GET', '/admin/workspaces?q=owner@agency');
    assert.equal(list.data.workspaces.length, 1);
    assert.equal(list.data.workspaces[0].clients, 1);
    assert.equal((await api('POST', `/admin/workspaces/${ws}/suspend`, { reason: 'Unpaid' })).status, 403);
    assert.equal((await api('POST', `/admin/workspaces/${ws}/impersonate`, {})).status, 422);
    assert.equal((await api('POST', `/admin/workspaces/${ws}/impersonate`, { reason: 'Ticket 42' })).status, 200);
    const asCustomer = (await api('GET', '/me')).data;
    assert.equal(asCustomer.user.email, 'owner@agency.example');
    assert.equal(asCustomer.impersonating.by, 'sam@surecast.live');
    assert.equal((await api('GET', '/admin/overview')).status, 404); // no admin while viewing as someone
    assert.equal((await api('POST', '/impersonation/stop')).status, 200);
    assert.equal((await api('GET', '/me')).data.user.email, 'sam@surecast.live');

    // A superadmin from ADMIN_EMAILS suspends: publishing stops and the workspace is read-only.
    config.adminEmails.push('anup@surecast.live');
    try {
      await signIn('anup@surecast.live');
      assert.equal((await api('GET', '/admin/me')).data.role, 'superadmin');
      const over = (await api('GET', '/admin/overview')).data;
      assert.ok(over.workspaces.total >= 3);
      assert.equal(over.publishing.scheduled, 1);
      const sus = await api('POST', `/admin/workspaces/${ws}/suspend`, { reason: 'Unpaid invoice' });
      assert.equal(sus.data.held, 1);
      assert.equal((await one('SELECT status FROM post_targets'))!.status, 'paused');
      assert.equal((await api('PATCH', `/admin/workspaces/${ws}`, { plan: 'agency', extendTrialDays: 7, staffNotes: 'Called them' })).status, 200);
      assert.equal((await api('POST', '/admin/announcements', { title: 'Maintenance tonight', level: 'warning' })).status, 201);

      await signIn('owner@agency.example');
      const me = (await api('GET', '/me')).data;
      assert.equal(me.announcements[0].title, 'Maintenance tonight');
      assert.equal((await api('GET', '/workspace')).data.workspace.suspended.reason, 'Unpaid invoice');
      assert.equal((await api('POST', '/clients', { name: 'Blocked' })).status, 403);
      assert.equal((await api('GET', '/clients')).status, 200);

      await signIn('anup@surecast.live');
      assert.equal((await api('POST', `/admin/workspaces/${ws}/unsuspend`)).data.resumed, 1);
      assert.equal((await one('SELECT status FROM post_targets'))!.status, 'scheduled');
      const actions = (await api('GET', '/admin/audit')).data.entries.map((e: any) => e.action);
      for (const a of ['workspace.impersonate', 'workspace.impersonate_stop', 'workspace.suspend', 'workspace.update', 'announcement.create', 'workspace.unsuspend']) assert.ok(actions.includes(a), a);
      const staff = (await api('GET', '/admin/staff')).data.staff;
      assert.ok(staff.some((x: any) => x.email === 'anup@surecast.live' && x.fixed));
      assert.equal((await api('POST', '/admin/staff', { email: 'ria@surecast.live', role: 'analyst' })).status, 201);

      assert.equal((await api('DELETE', `/admin/workspaces/${ws}`, { confirm: 'wrong' })).status, 422);
      const name = (await one<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [ws]))!.name;
      const del = await api('DELETE', `/admin/workspaces/${ws}`, { confirm: name });
      assert.equal(del.status, 200);
      for (const t of ['workspaces', 'clients', 'channels', 'posts', 'post_targets', 'members']) assert.equal((await all(`SELECT * FROM ${t} WHERE ${t === 'workspaces' ? 'id' : 'workspace_id'} = ?`, [ws])).length, 0, t);
    } finally {
      config.adminEmails.pop();
    }
  });

  it('enforces the plan’s client limit', async () => {
    const s = await seed();
    await run("UPDATE workspaces SET plan = 'solo' WHERE id = ?", [s.wsId]);
    for (let i = 0; i < 9; i++) await run("INSERT INTO clients (id, workspace_id, name, timezone, share_token, created_at) VALUES (?, ?, ?, 'UTC', ?, ?)", [newId('cli'), s.wsId, `C${i}`, newId('t'), new Date()]);
    const key = generateApiKey();
    await run('INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [newId('key'), s.wsId, 'k', key.slice(0, 14), hashSecret(key), s.userId, new Date()]);
    const app = createApp();
    const res = await app.request('/v1/clients', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ name: 'Eleventh' }) });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as any).error, /10 clients/);
  });

  it('publishes an OpenAPI description and the new MCP tools', async () => {
    fakeAdapter();
    const s = await seed();
    const app = createApp();
    const spec = (await (await app.request('/v1/openapi.json')).json()) as any;
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.paths['/clients/{id}/pause'].post);
    assert.ok(spec.paths['/ai/campaign'].post.requestBody.content['application/json'].schema.required.includes('url'));

    const key = generateApiKey();
    await run('INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [newId('key'), s.wsId, 'k', key.slice(0, 14), hashSecret(key), s.userId, new Date()]);
    const rpc = async (body: unknown) =>
      (await (await app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) })).json()) as any;
    const names = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t: any) => t.name);
    for (const n of ['pause_client', 'resume_client', 'check_brand_guard', 'list_moments', 'create_campaign_from_url']) assert.ok(names.includes(n), n);
    const paused = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pause_client', arguments: { client_id: s.clientId, reason: 'Recall' } } });
    assert.equal(paused.result.isError, false);
    assert.ok((await one('SELECT paused_at FROM clients WHERE id = ?', [s.clientId]))!.paused_at);
    const moments = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_moments', arguments: { from: '2026-12-01', to: '2026-12-31' } } });
    assert.ok(moments.result.structuredContent.moments.some((m: any) => m.name === 'Christmas Day'));
    // A suspended workspace is read-only for agents too.
    await run('UPDATE workspaces SET suspended_at = ? WHERE id = ?', [new Date(), s.wsId]);
    const blocked = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'resume_client', arguments: { client_id: s.clientId } } });
    assert.equal(blocked.result.isError, true);
    assert.match(blocked.result.content[0].text, /suspended/);
  });
});
