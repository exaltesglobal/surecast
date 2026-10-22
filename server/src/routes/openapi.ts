// The public REST API, described as OpenAPI 3.1 at /v1/openapi.json so developers (and tools like
// Postman, Zapier's API builder or an AI agent) can read it. The same routes power the web app.
import { Hono } from 'hono';

import type { Env } from '../auth.js';
import { config } from '../config.js';

type Field = [name: string, type: string, description: string, required?: boolean];
type Op = { method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string; tag: string; summary: string; body?: Field[]; query?: Field[]; admin?: boolean };

const OPS: Op[] = [
  { method: 'get', path: '/workspace', tag: 'Workspace', summary: 'The workspace this key belongs to, with its plan and time zone.' },
  { method: 'get', path: '/dashboard', tag: 'Workspace', summary: 'What needs attention now: failures, approvals, channels at risk and the next posts.' },
  { method: 'get', path: '/platforms', tag: 'Workspace', summary: 'Networks Surecast can publish to, with their limits.' },

  { method: 'get', path: '/clients', tag: 'Clients', summary: 'All clients with voice, posting times, brand guard, pause state and channel counts.' },
  {
    method: 'post',
    path: '/clients',
    tag: 'Clients',
    summary: 'Adds a client.',
    body: [
      ['name', 'string', 'Client name.', true],
      ['timezone', 'string', 'IANA time zone, e.g. Asia/Kolkata.'],
      ['approvalRequired', 'boolean', 'Posts wait for the client to approve them.'],
      ['contactEmail', 'string', 'Where approval requests and the weekly digest go.'],
    ],
  },
  {
    method: 'patch',
    path: '/clients/{id}',
    tag: 'Clients',
    summary: 'Updates a client: details, brand voice, brand guard, WhatsApp number and weekly digest.',
    body: [
      ['name', 'string', ''],
      ['voice', 'object', '{ description, audience, dos, donts, examples, language }'],
      ['guard', 'object', '{ banned: string[], required: string[], mode: "block" | "warn" }'],
      ['whatsappPhone', 'string', 'Client WhatsApp number with country code, for approval requests.'],
      ['digestEnabled', 'boolean', 'Send the client a weekly summary every Monday.'],
      ['archived', 'boolean', ''],
    ],
  },
  {
    method: 'post',
    path: '/clients/{id}/pause',
    tag: 'Emergency brake',
    summary: 'Holds every unsent post for the client, on every network.',
    body: [
      ['reason', 'string', 'Why, for the team.'],
      ['until', 'string', 'Optional ISO 8601 time to resume automatically.'],
      ['missed', 'string', 'What to do with slots that pass while paused: skip, post_now or queue.'],
    ],
  },
  { method: 'post', path: '/clients/{id}/resume', tag: 'Emergency brake', summary: 'Lifts the brake.', body: [['missed', 'string', 'skip, post_now or queue.']] },
  { method: 'get', path: '/clients/{id}/queue', tag: 'Clients', summary: 'Weekly posting times.' },
  { method: 'put', path: '/clients/{id}/queue', tag: 'Clients', summary: 'Replaces the weekly posting times.', body: [['slots', 'array', '[{ day: 0-6, time: "HH:MM" }]', true]] },
  { method: 'get', path: '/clients/{id}/best-times', tag: 'Analytics', summary: 'When this client’s audience responds best.' },
  { method: 'get', path: '/clients/{id}/digest', tag: 'Clients', summary: 'Preview of the weekly client digest.' },

  { method: 'get', path: '/channels', tag: 'Channels', summary: 'Connected social accounts and their health.' },
  { method: 'post', path: '/channels/{id}/check', tag: 'Channels', summary: 'Checks a channel’s connection now.' },

  {
    method: 'get',
    path: '/posts',
    tag: 'Posts',
    summary: 'Lists posts.',
    query: [
      ['client', 'string', 'Client id.'],
      ['status', 'string', 'draft, awaiting_approval, scheduled, paused, publishing, published, partial, failed, cancelled.'],
    ],
  },
  {
    method: 'post',
    path: '/posts',
    tag: 'Posts',
    summary: 'Creates a post. Each channel’s rules and the client’s brand guard are checked first.',
    body: [
      ['clientId', 'string', '', true],
      ['body', 'string', 'Post text.', true],
      ['channelIds', 'array', 'Channel ids.', true],
      ['action', 'string', 'draft, now, schedule or queue.', true],
      ['scheduledAt', 'string', 'ISO 8601, for action "schedule".'],
      ['overrides', 'object', '{ channelId: text } to change the text per channel.'],
      ['mediaIds', 'array', 'Uploaded media ids.'],
      ['thread', 'array', 'Follow-up parts.'],
      ['firstComment', 'string', ''],
      ['recycle', 'object', '{ days, times } to repost evergreen content.'],
    ],
  },
  { method: 'post', path: '/posts/validate', tag: 'Posts', summary: 'Checks a draft against every channel and the brand guard without saving it.' },
  { method: 'get', path: '/posts/{id}', tag: 'Posts', summary: 'A post with every attempt, error and comment.' },
  { method: 'patch', path: '/posts/{id}', tag: 'Posts', summary: 'Edits a post that has not gone out.' },
  { method: 'post', path: '/posts/{id}/retry', tag: 'Posts', summary: 'Retries failed channels.' },
  { method: 'post', path: '/posts/{id}/cancel', tag: 'Posts', summary: 'Cancels whatever has not gone out yet.' },
  { method: 'post', path: '/posts/{id}/duplicate', tag: 'Posts', summary: 'Copies a post as a draft.' },
  { method: 'post', path: '/guard/check', tag: 'Posts', summary: 'Checks text against a client’s brand guard.', body: [['clientId', 'string', '', true], ['text', 'string', '', true]] },
  { method: 'post', path: '/media', tag: 'Media', summary: 'Uploads an image (up to 10 MB) or an MP4, MOV or WebM video (up to 100 MB) as multipart/form-data, field "file".' },
  { method: 'get', path: '/media', tag: 'Media', summary: 'The media library.' },

  { method: 'get', path: '/alerts', tag: 'Alerts', summary: 'Open alerts: failures, disconnected channels, approvals and paused clients.' },
  { method: 'post', path: '/alerts/{id}/resolve', tag: 'Alerts', summary: 'Marks an alert resolved.' },

  { method: 'get', path: '/inbox', tag: 'Inbox', summary: 'Comments and WhatsApp messages across every client.', query: [['status', 'string', 'open or done.'], ['client', 'string', ''], ['platform', 'string', '']] },
  { method: 'post', path: '/inbox/{id}/reply', tag: 'Inbox', summary: 'Replies to a comment or WhatsApp message.', body: [['text', 'string', '', true]] },
  { method: 'post', path: '/inbox/{id}/suggest', tag: 'Inbox', summary: 'Three reply suggestions in the client’s voice.' },

  { method: 'get', path: '/analytics', tag: 'Analytics', summary: 'Results for a period.', query: [['client', 'string', ''], ['days', 'integer', '7 to 365.']] },
  { method: 'get', path: '/analytics/export', tag: 'Analytics', summary: 'The same, as CSV.' },

  { method: 'get', path: '/moments', tag: 'Moments', summary: 'Holidays, awareness days and the agency’s own dates.', query: [['from', 'string', 'YYYY-MM-DD'], ['to', 'string', 'YYYY-MM-DD'], ['regions', 'string', 'global,in,us,uk']] },
  { method: 'post', path: '/moments', tag: 'Moments', summary: 'Adds an agency date.', body: [['date', 'string', 'YYYY-MM-DD', true], ['name', 'string', '', true], ['note', 'string', ''], ['clientId', 'string', ''], ['yearly', 'boolean', '']] },
  { method: 'delete', path: '/moments/{id}', tag: 'Moments', summary: 'Removes an agency date.' },

  { method: 'post', path: '/ai/write', tag: 'AI assistant', summary: 'Drafts posts from a brief.' },
  { method: 'post', path: '/ai/adapt', tag: 'AI assistant', summary: 'Rewrites a post for each network.' },
  { method: 'post', path: '/ai/ideas', tag: 'AI assistant', summary: 'Post ideas for a client or a moment.' },
  {
    method: 'post',
    path: '/ai/campaign',
    tag: 'AI assistant',
    summary: 'Turns a web page into a campaign of posts, saved as drafts or queued.',
    body: [['clientId', 'string', '', true], ['url', 'string', '', true], ['count', 'integer', '2 to 14'], ['channelIds', 'array', ''], ['mode', 'string', 'draft or queue'], ['goal', 'string', '']],
  },

  { method: 'get', path: '/integrations/chitthi', tag: 'Integrations', summary: 'Chitthi (WhatsApp) connections for the agency and each client.' },
  {
    method: 'post',
    path: '/integrations/chitthi',
    tag: 'Integrations',
    summary: 'Connects Chitthi. Without clientId: approvals and alerts on WhatsApp. With clientId: that client’s WhatsApp chats in the inbox.',
    body: [['apiKey', 'string', 'chk_live_...', true], ['clientId', 'string', ''], ['settings', 'object', '{ alertPhones, alerts, approvals, approvalTemplate, alertTemplate }']],
  },

  { method: 'get', path: '/webhooks', tag: 'Webhooks', summary: 'Outgoing webhooks.' },
  { method: 'post', path: '/webhooks', tag: 'Webhooks', summary: 'Adds a webhook. Events: post.published, post.failed, client.paused, client.resumed, ping.', body: [['url', 'string', 'https://...', true]] },
];

const schemaFor = (type: string) => (type === 'array' ? { type: 'array', items: {} } : type === 'object' ? { type: 'object' } : { type });

export function openApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of OPS) {
    const params = [
      ...[...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      ...(op.query ?? []).map(([name, type, description]) => ({ name, in: 'query', required: false, description, schema: schemaFor(type) })),
    ];
    (paths[op.path] ??= {})[op.method] = {
      tags: [op.tag],
      summary: op.summary,
      operationId: `${op.method}${op.path.replace(/\{(\w+)\}/g, 'By_$1').replace(/[^a-zA-Z0-9]+(\w)/g, (_, ch: string) => ch.toUpperCase())}`,
      ...(params.length ? { parameters: params } : {}),
      ...(op.body
        ? {
            requestBody: {
              required: op.body.some((f) => f[3]),
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: Object.fromEntries(op.body.map(([name, type, description]) => [name, { ...schemaFor(type), ...(description ? { description } : {}) }])),
                    required: op.body.filter((f) => f[3]).map((f) => f[0]),
                  },
                },
              },
            },
          }
        : {}),
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        '4XX': { description: 'A problem you can fix. The body is { error: "plain-language message", details?: [...] }.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Surecast API',
      version: '1.0.0',
      description:
        'Schedule, publish and track social media posts for every client. Create a key in Settings > API keys and send it as "Authorization: Bearer sc_live_...". ' +
        'An MCP server for AI agents is at /mcp with the same key. Errors are JSON with a plain-language "error" message.',
      contact: { email: 'hello@surecast.live', url: 'https://surecast.live' },
    },
    servers: [{ url: `${config.publicUrl}/v1` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'sc_live_...' } },
      schemas: { Error: { type: 'object', properties: { error: { type: 'string' }, details: {} }, required: ['error'] } },
    },
    tags: [...new Set(OPS.map((o) => o.tag))].map((name) => ({ name })),
    paths,
  };
}

export const openApiRoutes = new Hono<Env>().get('/openapi.json', (c) => c.json(openApi()));
