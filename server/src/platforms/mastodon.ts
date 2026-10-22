// Mastodon (and compatible servers). Surecast registers itself on each instance the
// first time someone connects from it, then uses normal OAuth. Tokens do not expire.
import { config } from '../config.js';
import { one, run } from '../db.js';
import { blobOf, http } from './http.js';
import { mastodonLength } from './text.js';
import { PublishError, type Adapter, type PostMetrics, type RemoteComment } from './types.js';

type Creds = { instance: string; accessToken: string };

/** Mastodon sends HTML; the inbox shows plain text. */
const htmlToText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

function normaliseInstance(v: string) {
  const raw = v.trim().replace(/^@?[^@\s]+@/, '');
  const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  if (url.protocol !== 'https:') throw new PublishError('permanent', 'bad_instance', 'Mastodon servers must use https', 'Enter the server name, e.g. mastodon.social.');
  return url.origin;
}

async function appFor(instance: string, redirectUri: string) {
  const existing = await one<{ client_id: string; client_secret: string }>('SELECT client_id, client_secret FROM oauth_apps WHERE platform = ? AND instance = ?', ['mastodon', `${instance}|${redirectUri}`]);
  if (existing) return existing;
  const { data } = await http<{ client_id: string; client_secret: string }>('Mastodon', `${instance}/api/v1/apps`, {
    json: { client_name: 'Surecast', redirect_uris: redirectUri, scopes: 'read write', website: config.publicUrl },
  });
  await run('INSERT INTO oauth_apps (platform, instance, client_id, client_secret, created_at) VALUES (?, ?, ?, ?, ?)', ['mastodon', `${instance}|${redirectUri}`, data.client_id, data.client_secret, new Date()]);
  return data;
}

async function waitForMedia(instance: string, token: string, id: string) {
  for (let i = 0; i < 20; i++) {
    const res = await http<{ url: string | null }>('Mastodon', `${instance}/api/v1/media/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 200 && res.data.url) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new PublishError('temporary', 'media_processing', 'Mastodon is still processing the image', 'Surecast will retry shortly.');
}

export const mastodon: Adapter = {
  platform: 'mastodon',
  label: 'Mastodon',
  limits: { maxChars: 500, maxImages: 4, maxImageBytes: 8_000_000, imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
  idempotent: true,
  available: () => true,
  count: mastodonLength,
  connect: {
    kind: 'oauth',
    help: 'Enter your server, then approve Surecast on it.',
    fields: [{ name: 'instance', label: 'Server', type: 'text', placeholder: 'mastodon.social', required: true }],
    async start({ state, redirectUri, values }) {
      const instance = normaliseInstance(values.instance ?? '');
      const app = await appFor(instance, redirectUri);
      const q = new URLSearchParams({ client_id: app.client_id, response_type: 'code', redirect_uri: redirectUri, scope: 'read write', state });
      return { url: `${instance}/oauth/authorize?${q}`, data: { instance } };
    },
    async finish({ code, redirectUri, data }) {
      const instance = String(data.instance);
      const app = await appFor(instance, redirectUri);
      const tok = await http<{ access_token: string }>('Mastodon', `${instance}/oauth/token`, {
        form: { grant_type: 'authorization_code', code, client_id: app.client_id, client_secret: app.client_secret, redirect_uri: redirectUri, scope: 'read write' },
      });
      const me = await http<{ id: string; username: string; display_name: string; avatar: string }>('Mastodon', `${instance}/api/v1/accounts/verify_credentials`, {
        headers: { Authorization: `Bearer ${tok.data.access_token}` },
      });
      const host = new URL(instance).host;
      return [
        {
          platform: 'mastodon',
          name: me.data.display_name || me.data.username,
          handle: `@${me.data.username}@${host}`,
          externalId: me.data.id,
          avatarUrl: me.data.avatar ?? null,
          credentials: { instance, accessToken: tok.data.access_token } satisfies Creds,
          tokenExpiresAt: null,
        },
      ];
    },
  },
  async check(ch) {
    const c = ch.credentials as Creds;
    const { data } = await http<{ display_name: string; avatar: string }>('Mastodon', `${c.instance}/api/v1/accounts/verify_credentials`, { headers: { Authorization: `Bearer ${c.accessToken}` } });
    return { name: data.display_name || undefined, avatarUrl: data.avatar ?? null };
  },
  async publish(ch, input) {
    const c = ch.credentials as Creds;
    const auth = { Authorization: `Bearer ${c.accessToken}` };
    const mediaIds: string[] = [];
    for (const m of input.media) {
      const form = new FormData();
      form.append('file', await blobOf(m), m.filename);
      if (m.alt) form.append('description', m.alt);
      const res = await http<{ id: string; url: string | null }>('Mastodon', `${c.instance}/api/v2/media`, { method: 'POST', headers: auth, body: form, timeoutMs: 90_000 });
      if (res.status === 202 || !res.data.url) await waitForMedia(c.instance, c.accessToken, res.data.id);
      mediaIds.push(res.data.id);
    }
    // The idempotency key makes a retried request return the original post instead of a duplicate.
    const { data } = await http<{ id: string; url: string }>('Mastodon', `${c.instance}/api/v1/statuses`, {
      headers: { ...auth, 'Idempotency-Key': input.idempotencyKey },
      json: { status: input.text, media_ids: mediaIds, visibility: 'public' },
    });
    return { remoteId: data.id, url: data.url };
  },
  followUps: 'thread',
  async reply(ch, target, text, idempotencyKey) {
    const c = ch.credentials as Creds;
    const { data } = await http<{ id: string; url: string }>('Mastodon', `${c.instance}/api/v1/statuses`, {
      headers: { Authorization: `Bearer ${c.accessToken}`, 'Idempotency-Key': idempotencyKey },
      json: { status: text, in_reply_to_id: target.parentId, visibility: 'public' },
    });
    return { remoteId: data.id, url: data.url };
  },
  async metrics(ch, ids) {
    const c = ch.credentials as Creds;
    const out: Record<string, PostMetrics> = {};
    for (const id of ids) {
      try {
        const { data } = await http<{ favourites_count: number; replies_count: number; reblogs_count: number }>('Mastodon', `${c.instance}/api/v1/statuses/${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${c.accessToken}` },
        });
        out[id] = { likes: data.favourites_count ?? 0, comments: data.replies_count ?? 0, shares: data.reblogs_count ?? 0, views: null };
      } catch (e) {
        // A deleted post is skipped; anything else (rate limit, outage) stops this round.
        if (!(e instanceof PublishError) || e.httpStatus !== 404) throw e;
      }
    }
    return out;
  },
  async followers(ch) {
    const c = ch.credentials as Creds;
    const { data } = await http<{ followers_count?: number }>('Mastodon', `${c.instance}/api/v1/accounts/verify_credentials`, { headers: { Authorization: `Bearer ${c.accessToken}` } });
    return data.followers_count ?? null;
  },
  async comments(ch, ids) {
    const c = ch.credentials as Creds;
    const out: Record<string, RemoteComment[]> = {};
    type S = { id: string; in_reply_to_id: string; url: string; created_at: string; content: string; account: { id: string; acct: string; display_name: string; avatar: string } };
    for (const id of ids) {
      try {
        const { data } = await http<{ descendants: S[] }>('Mastodon', `${c.instance}/api/v1/statuses/${encodeURIComponent(id)}/context`, { headers: { Authorization: `Bearer ${c.accessToken}` } });
        out[id] = data.descendants
          .filter((s) => s.account.id !== ch.externalId)
          .map((s) => ({
            id: s.id,
            parentId: s.in_reply_to_id,
            authorName: s.account.display_name || s.account.acct,
            authorHandle: `@${s.account.acct}`,
            authorAvatar: s.account.avatar ?? null,
            text: htmlToText(s.content),
            createdAt: new Date(s.created_at),
            url: s.url,
          }));
      } catch (e) {
        if (!(e instanceof PublishError) || e.httpStatus !== 404) throw e;
      }
    }
    return out;
  },
};
