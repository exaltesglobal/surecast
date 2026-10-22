// A Model Context Protocol server, so AI agents (Claude, ChatGPT, Cursor and others) can plan,
// schedule and check posts. It speaks MCP's Streamable HTTP transport with plain JSON responses
// at POST /mcp, and signs in with a workspace API key: "Authorization: Bearer sc_live_...".
import { Hono } from 'hono';

import { HttpError, type Env } from '../auth.js';
import { all, one } from '../db.js';
import { aiEnabled, campaignFromUrl, writePosts } from '../engine/ai.js';
import { analytics, bestTimes } from '../engine/analytics.js';
import { pauseClient, resumeClient } from '../engine/brake.js';
import { guardIssues, parseGuard } from '../engine/guard.js';
import { listInbox, replyToItem } from '../engine/inbox.js';
import { listMoments } from '../engine/moments.js';
import { cancelPost, getClient, postsJson, savePost } from '../engine/posts.js';
import { nextQueueSlot } from '../engine/queue.js';

type Ctx = { workspaceId: string; user: Env['Variables']['user']; suspended?: boolean };
type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; run: (args: Record<string, any>, ctx: Ctx) => Promise<unknown> };

const str = (description: string) => ({ type: 'string', description });
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const READ = { readOnlyHint: true, openWorldHint: false };

const TOOLS: Tool[] = [
  {
    name: 'list_clients',
    description: 'Lists the agency’s clients with their time zone, approval setting and connected channels. Start here: most other tools need a client_id.',
    inputSchema: schema({}),
    annotations: READ,
    async run(_a, { workspaceId }) {
      const clients = await all('SELECT id, name, timezone, approval_required, queue_slots FROM clients WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name', [workspaceId]);
      const channels = await all("SELECT id, client_id, platform, name, handle, status FROM channels WHERE workspace_id = ? ORDER BY platform", [workspaceId]);
      return clients.map((c) => ({
        id: c.id,
        name: c.name,
        timezone: c.timezone,
        approval_required: !!c.approval_required,
        has_posting_times: !!JSON.parse(c.queue_slots || '[]').length,
        channels: channels.filter((ch) => ch.client_id === c.id).map((ch) => ({ id: ch.id, network: ch.platform, name: ch.name, handle: ch.handle, status: ch.status })),
      }));
    },
  },
  {
    name: 'create_post',
    description:
      'Creates a post for a client on one or more of their channels. "when" is "now", "queue" (the next free posting time), "draft", or an ISO 8601 date-time such as 2026-11-05T09:30:00+05:30. ' +
      'Every channel’s length and format rules are checked first; if a channel cannot take the post, nothing is saved and the problems are returned. ' +
      'If the client approves posts, scheduled posts wait for their approval.',
    inputSchema: schema(
      {
        client_id: str('The client, from list_clients.'),
        text: str('The post text.'),
        channel_ids: { type: 'array', items: { type: 'string' }, description: 'Channel ids; leave out to use all of the client’s connected channels.' },
        when: str('"now", "queue", "draft" or an ISO 8601 date-time with an offset.'),
        thread: { type: 'array', items: { type: 'string' }, description: 'Optional follow-up parts, posted as a thread on X, Bluesky, Mastodon, Threads and Telegram.' },
        first_comment: str('Optional comment posted under the post right after it goes out.'),
      },
      ['client_id', 'text', 'when'],
    ),
    annotations: { destructiveHint: false, openWorldHint: true },
    async run(a, { workspaceId, user }) {
      const client = await getClient(workspaceId, a.client_id);
      let channelIds: string[] = Array.isArray(a.channel_ids) ? a.channel_ids : [];
      if (!channelIds.length) channelIds = (await all<{ id: string }>("SELECT id FROM channels WHERE client_id = ? AND status <> 'disconnected'", [client.id])).map((c) => c.id);
      const when = String(a.when ?? 'draft');
      const action = ['now', 'queue', 'draft'].includes(when) ? when : 'schedule';
      const id = await savePost(workspaceId, user, { clientId: client.id, body: a.text, channelIds, action, scheduledAt: action === 'schedule' ? when : undefined, thread: a.thread, firstComment: a.first_comment }, undefined, 'api');
      const [post] = await postsJson([(await one('SELECT * FROM posts WHERE id = ?', [id]))!]);
      return summarise(post);
    },
  },
  {
    name: 'list_posts',
    description: 'Lists posts, newest scheduled time first. Filter by client and status (draft, awaiting_approval, scheduled, published, partial, failed).',
    inputSchema: schema({ client_id: str('Optional client.'), status: str('Optional status.'), limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    annotations: READ,
    async run(a, { workspaceId }) {
      const where = ['workspace_id = ?'];
      const params: unknown[] = [workspaceId];
      if (a.client_id) where.push('client_id = ?'), params.push(a.client_id);
      if (a.status) where.push('status = ?'), params.push(a.status);
      const rows = await all(`SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ${Math.min(Number(a.limit) || 20, 100)}`, params);
      return (await postsJson(rows)).map(summarise);
    },
  },
  {
    name: 'get_post',
    description: 'One post with each channel’s delivery status, live link, errors with what to do about them, and engagement numbers.',
    inputSchema: schema({ post_id: str('The post id.') }, ['post_id']),
    annotations: READ,
    async run(a, { workspaceId }) {
      const row = await one('SELECT * FROM posts WHERE id = ? AND workspace_id = ?', [a.post_id, workspaceId]);
      if (!row) throw new HttpError(404, 'Post not found.');
      const [post] = await postsJson([row]);
      return summarise(post);
    },
  },
  {
    name: 'cancel_post',
    description: 'Cancels a scheduled post on the channels where it has not gone out yet. Posts already published are not deleted from the networks.',
    inputSchema: schema({ post_id: str('The post id.') }, ['post_id']),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run(a, { workspaceId }) {
      await cancelPost(workspaceId, a.post_id);
      return { cancelled: true };
    },
  },
  {
    name: 'next_free_slot',
    description: 'The next free posting time for a client, from their weekly posting times.',
    inputSchema: schema({ client_id: str('The client.') }, ['client_id']),
    annotations: READ,
    async run(a, { workspaceId }) {
      const client = await getClient(workspaceId, a.client_id);
      return { next: (await nextQueueSlot(client, new Date())).toISOString(), timezone: client.timezone };
    },
  },
  {
    name: 'get_analytics',
    description: 'Results for a period: posts delivered, likes, comments, shares, link clicks and followers, with the previous period, per network, and the top posts.',
    inputSchema: schema({ client_id: str('Optional client; leave out for the whole agency.'), days: { type: 'integer', minimum: 1, maximum: 365 } }),
    annotations: READ,
    async run(a, { workspaceId }) {
      const r = await analytics(workspaceId, { clientId: a.client_id || undefined, days: Number(a.days) || 30 });
      return { days: r.days, summary: r.summary, previous: r.previous, networks: r.networks, top: r.top.slice(0, 5), followers: r.followers.map(({ series, ...f }) => f) };
    },
  },
  {
    name: 'best_posting_times',
    description: 'The weekly times when a client’s audience responds best, from their own results (or common good times until there is enough data).',
    inputSchema: schema({ client_id: str('The client.') }, ['client_id']),
    annotations: READ,
    run: (a, { workspaceId }) => bestTimes(workspaceId, a.client_id),
  },
  {
    name: 'list_inbox',
    description: 'Comments and replies people left under published posts, across every network. Defaults to ones not yet handled.',
    inputSchema: schema({ client_id: str('Optional client.'), status: str('"open" (default) or "done".'), limit: { type: 'integer', minimum: 1, maximum: 100 } }),
    annotations: READ,
    async run(a, { workspaceId }) {
      const r = await listInbox(workspaceId, { clientId: a.client_id || undefined, status: a.status || 'open', limit: Number(a.limit) || 30 });
      return r.items.map((i) => ({ id: i.id, client: i.clientName, network: i.platform, from: i.author.name, text: i.text, on_post: i.postText, received_at: i.receivedAt, status: i.status }));
    },
  },
  {
    name: 'reply_to_comment',
    description: 'Publicly replies to a comment from list_inbox, as the client, and marks it handled. Check the wording with the person first.',
    inputSchema: schema({ item_id: str('The inbox item id.'), text: str('The reply.') }, ['item_id', 'text']),
    annotations: { destructiveHint: false, openWorldHint: true },
    async run(a, { workspaceId, user }) {
      const item = await replyToItem(workspaceId, user, a.item_id, a.text);
      return { replied: true, item: item && { id: item.id, status: item.status } };
    },
  },
  {
    name: 'draft_posts_with_ai',
    description: 'Writes three post options from a short brief in the client’s saved brand voice, sized for the chosen networks. Nothing is saved; pass the one you like to create_post.',
    inputSchema: schema({ client_id: str('The client.'), brief: str('What the post is about.'), networks: { type: 'array', items: { type: 'string' } } }, ['client_id', 'brief']),
    annotations: READ,
    async run(a, { workspaceId }) {
      if (!aiEnabled()) throw new HttpError(503, 'The writing assistant is switched off for this workspace.');
      return writePosts(workspaceId, { clientId: a.client_id, brief: a.brief, platforms: a.networks ?? [] });
    },
  },
  {
    name: 'pause_client',
    description:
      'Emergency brake: holds every post for a client that has not gone out yet, on every network, until resumed. Use it for a crisis, a bereavement or a recall. ' +
      'Optionally resume automatically at an ISO 8601 time. "missed" decides what happens to slots that pass while paused: "skip" (default), "post_now" or "queue".',
    inputSchema: schema({ client_id: str('The client.'), reason: str('Why, for the team.'), until: str('Optional ISO 8601 time to resume automatically.'), missed: str('"skip", "post_now" or "queue".') }, ['client_id', 'reason']),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a, { workspaceId, user }) {
      return pauseClient(workspaceId, String(a.client_id), { reason: a.reason, until: a.until, missed: a.missed, by: `${user?.name || user?.email || 'API'} (AI agent)` }, user);
    },
  },
  {
    name: 'resume_client',
    description: 'Lifts the emergency brake. Posts whose time is still ahead keep it; slots that passed while paused are skipped, posted now or moved to the next queue slots ("skip", "post_now", "queue").',
    inputSchema: schema({ client_id: str('The client.'), missed: str('"skip", "post_now" or "queue". Defaults to what was chosen when pausing.') }, ['client_id']),
    annotations: { destructiveHint: false, openWorldHint: true },
    async run(a, { workspaceId, user }) {
      return resumeClient(workspaceId, String(a.client_id), a.missed, user);
    },
  },
  {
    name: 'check_brand_guard',
    description: 'Checks text against a client’s brand safety rules (words they never allow, lines they always need, such as an ad disclosure). Run it before create_post.',
    inputSchema: schema({ client_id: str('The client.'), text: str('The post text.') }, ['client_id', 'text']),
    annotations: READ,
    async run(a, { workspaceId }) {
      const c = await one<{ guard: string | null }>('SELECT guard FROM clients WHERE id = ? AND workspace_id = ?', [String(a.client_id), workspaceId]);
      if (!c) throw new HttpError(404, 'Client not found.');
      const guard = parseGuard(c.guard);
      const issues = guardIssues(guard, String(a.text ?? ''));
      return { ok: !issues.length, mode: guard.mode, issues, rules: guard };
    },
  },
  {
    name: 'list_moments',
    description:
      'Dates worth posting about between two days (YYYY-MM-DD): holidays, awareness days and shopping days for India, the US, the UK and worldwide, plus the agency’s own dates. ' +
      'Festivals that follow the lunar calendar are marked approximate.',
    inputSchema: schema({ from: str('Start date, YYYY-MM-DD. Defaults to today.'), to: str('End date, YYYY-MM-DD. Defaults to 60 days after from.'), regions: str('Optional comma list: global, in, us, uk.') }),
    annotations: READ,
    async run(a, { workspaceId }) {
      return listMoments(workspaceId, { from: a.from, to: a.to, regions: a.regions });
    },
  },
  {
    name: 'create_campaign_from_url',
    description:
      'Reads a web page (a product, article or event) and writes a campaign of 2 to 14 posts about it in the client’s voice, saved as drafts or into the client’s queue. ' +
      'Needs the writing assistant to be switched on.',
    inputSchema: schema(
      {
        client_id: str('The client.'),
        url: str('The page to write about.'),
        count: { type: 'integer', minimum: 2, maximum: 14 },
        channel_ids: { type: 'array', items: { type: 'string' }, description: 'Channels to post on; needed for "queue".' },
        mode: str('"draft" (default) or "queue".'),
        goal: str('Optional goal, such as "sell tickets".'),
      },
      ['client_id', 'url'],
    ),
    annotations: { destructiveHint: false, openWorldHint: true },
    async run(a, { workspaceId, user }) {
      if (!aiEnabled()) throw new HttpError(503, 'The writing assistant is switched off for this workspace.');
      return campaignFromUrl(workspaceId, user, { clientId: a.client_id, url: a.url, count: a.count, channelIds: a.channel_ids, mode: a.mode, goal: a.goal });
    },
  },
];

type PostJson = Awaited<ReturnType<typeof postsJson>>[number];
function summarise(p: PostJson) {
  return {
    id: p.id,
    client_id: p.clientId,
    status: p.status,
    text: p.body,
    scheduled_at: p.scheduledAt,
    channels: p.targets.map((t) => ({
      network: t.platform,
      channel: t.channelName,
      status: t.status,
      live_url: t.remoteUrl,
      error: t.error ? `${t.error.message}. ${t.error.hint}` : null,
      metrics: t.metrics,
    })),
  };
}

const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

type RpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };
const ok = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(req: RpcRequest, ctx: Ctx) {
  switch (req.method) {
    case 'initialize': {
      const asked = req.params?.protocolVersion;
      return ok(req.id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'surecast', title: 'Surecast', version: '1.0.0' },
        instructions:
          'Surecast schedules and publishes social media posts for an agency’s clients and proves they went out. Call list_clients first. ' +
          'Posts are checked against every network’s rules before they are saved. Confirm wording and timing with the person before creating or replying publicly.',
      });
    }
    case 'ping':
      return ok(req.id, {});
    case 'tools/list':
      return ok(req.id, { tools: TOOLS.map(({ run: _r, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === req.params?.name);
      if (!tool) return fail(req.id, -32602, `Unknown tool: ${req.params?.name}`);
      if (ctx.suspended && !tool.annotations?.readOnlyHint)
        return ok(req.id, { content: [{ type: 'text', text: 'This workspace is suspended, so it is read-only. Contact hello@surecast.live.' }], isError: true });
      try {
        const result = await tool.run(req.params?.arguments ?? {}, ctx);
        return ok(req.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: Array.isArray(result) ? { items: result } : result, isError: false });
      } catch (e) {
        // Problems the person can fix go back to the model as a tool error it can read and act on.
        if (e instanceof HttpError) {
          const details = (e as HttpError & { details?: unknown }).details;
          return ok(req.id, { content: [{ type: 'text', text: e.message + (details ? `\n${JSON.stringify(details)}` : '') }], isError: true });
        }
        console.error(`MCP tool ${tool.name} failed`, e);
        return ok(req.id, { content: [{ type: 'text', text: 'Something went wrong on Surecast’s side. Try again shortly.' }], isError: true });
      }
    }
    default:
      return req.id === undefined ? null : fail(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export const mcpRoutes = new Hono<Env>()
  .get('/mcp', (c) => c.json({ error: 'This MCP server answers POST requests only (Streamable HTTP, JSON responses).' }, 405))
  .delete('/mcp', (c) => c.body(null, 405))
  .post('/mcp', async (c) => {
    if (!c.get('viaApiKey')) {
      c.header('WWW-Authenticate', 'Bearer realm="surecast"');
      return c.json({ error: 'Use a workspace API key: Authorization: Bearer sc_live_... (Settings > API keys).' }, 401);
    }
    const ctx: Ctx = { workspaceId: c.get('workspaceId'), user: c.get('user'), suspended: c.get('suspended') };
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json(fail(null, -32700, 'Parse error'), 400);
    }
    const batch = Array.isArray(payload);
    const requests = (batch ? payload : [payload]) as RpcRequest[];
    const answers = [];
    for (const r of requests) {
      if (!r || r.jsonrpc !== '2.0' || typeof r.method !== 'string') {
        answers.push(fail((r as RpcRequest)?.id ?? null, -32600, 'Invalid request'));
        continue;
      }
      const a = await handle(r, ctx);
      if (a) answers.push(a);
    }
    // Notifications alone get an empty 202, as the transport requires.
    if (!answers.length) return c.body(null, 202);
    return c.json(batch ? answers : answers[0]);
  });
