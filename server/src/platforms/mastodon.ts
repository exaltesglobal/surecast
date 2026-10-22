// Mastodon (and compatible servers). Surecast registers itself on each instance the
// first time someone connects from it, then uses normal OAuth. Tokens do not expire.
import { config } from '../config.js';
import { one, run } from '../db.js';
import { blobOf, http } from './http.js';
import { mastodonLength } from './text.js';
import { PublishError, type Adapter } from './types.js';

type Creds = { instance: string; accessToken: string };

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
};
