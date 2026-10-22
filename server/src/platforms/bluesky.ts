// Bluesky (AT Protocol). Connects with a handle and an app password, which needs no
// developer app or review. Sessions are refreshed as needed and saved back.
import { blobOf, http } from './http.js';
import { URL_RE, graphemes } from './text.js';
import { PublishError, type Adapter, type ChannelCtx, type PostMetrics } from './types.js';

type Creds = { service: string; identifier: string; appPassword: string; did: string; accessJwt?: string; refreshJwt?: string };

const jwtExp = (jwt?: string) => {
  try {
    return jwt ? (JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp as number) * 1000 : 0;
  } catch {
    return 0;
  }
};

async function createSession(service: string, identifier: string, password: string) {
  try {
    const { data } = await http<{ did: string; handle: string; accessJwt: string; refreshJwt: string }>('Bluesky', `${service}/xrpc/com.atproto.server.createSession`, {
      json: { identifier, password },
    });
    return data;
  } catch (e) {
    if (e instanceof PublishError && (e.httpStatus === 401 || e.httpStatus === 400))
      throw new PublishError('auth', 'bad_app_password', 'Bluesky did not accept the handle and app password', 'Create a new app password in Bluesky (Settings > Privacy and security > App passwords) and reconnect this channel.', e.httpStatus);
    throw e;
  }
}

async function session(ch: ChannelCtx): Promise<Creds> {
  const c = ch.credentials as Creds;
  if (c.accessJwt && jwtExp(c.accessJwt) > Date.now() + 60_000) return c;
  if (c.refreshJwt && jwtExp(c.refreshJwt) > Date.now() + 60_000) {
    try {
      const { data } = await http<{ accessJwt: string; refreshJwt: string }>('Bluesky', `${c.service}/xrpc/com.atproto.server.refreshSession`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.refreshJwt}` },
      });
      const next = { ...c, accessJwt: data.accessJwt, refreshJwt: data.refreshJwt };
      await ch.saveCredentials(next, null);
      return next;
    } catch (e) {
      if (!(e instanceof PublishError) || e.kind === 'temporary') throw e;
    }
  }
  const s = await createSession(c.service, c.identifier, c.appPassword);
  const next = { ...c, did: s.did, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt };
  await ch.saveCredentials(next, null);
  return next;
}

const utf8Index = (s: string, charIndex: number) => Buffer.byteLength(s.slice(0, charIndex), 'utf8');

/** Rich-text facets so links, hashtags and mentions are clickable. Offsets are UTF-8 bytes. */
async function facets(text: string, service: string) {
  const out: unknown[] = [];
  for (const m of text.matchAll(URL_RE)) {
    out.push({ index: { byteStart: utf8Index(text, m.index!), byteEnd: utf8Index(text, m.index! + m[0].length) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  for (const m of text.matchAll(/(^|\s)(#[^\d\s\p{P}][^\s\p{P}]*)/gu)) {
    const start = m.index! + m[1].length;
    out.push({ index: { byteStart: utf8Index(text, start), byteEnd: utf8Index(text, start + m[2].length) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2].slice(1) }] });
  }
  for (const m of text.matchAll(/(^|\s)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) {
    try {
      const { data } = await http<{ did: string }>('Bluesky', `${service}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(m[2])}`, { timeoutMs: 10_000 });
      const start = m.index! + m[1].length;
      out.push({ index: { byteStart: utf8Index(text, start), byteEnd: utf8Index(text, start + m[2].length + 1) }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: data.did }] });
    } catch {
      /* unknown handle: leave as plain text */
    }
  }
  return out;
}

export const bluesky: Adapter = {
  platform: 'bluesky',
  label: 'Bluesky',
  limits: { maxChars: 300, maxImages: 4, maxImageBytes: 976_560, imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
  available: () => true,
  count: graphemes,
  connect: {
    kind: 'fields',
    help: 'Use an app password, not your main password. In Bluesky go to Settings > Privacy and security > App passwords.',
    fields: [
      { name: 'handle', label: 'Handle', type: 'text', placeholder: 'yourname.bsky.social', required: true },
      { name: 'appPassword', label: 'App password', type: 'password', placeholder: 'xxxx-xxxx-xxxx-xxxx', required: true },
      { name: 'service', label: 'Server (only for self-hosted accounts)', type: 'url', placeholder: 'https://bsky.social' },
    ],
    async submit(v) {
      const service = (v.service || 'https://bsky.social').replace(/\/+$/, '');
      const identifier = v.handle.trim().replace(/^@/, '');
      const s = await createSession(service, identifier, v.appPassword.trim());
      let name = s.handle;
      let avatarUrl: string | null = null;
      try {
        const { data } = await http<{ displayName?: string; avatar?: string }>('Bluesky', `${service}/xrpc/app.bsky.actor.getProfile?actor=${s.did}`, { headers: { Authorization: `Bearer ${s.accessJwt}` } });
        name = data.displayName || s.handle;
        avatarUrl = data.avatar ?? null;
      } catch {
        /* profile is cosmetic */
      }
      return {
        name,
        handle: `@${s.handle}`,
        externalId: s.did,
        avatarUrl,
        credentials: { service, identifier, appPassword: v.appPassword.trim(), did: s.did, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt } satisfies Creds,
        tokenExpiresAt: null,
      };
    },
  },
  async check(ch) {
    const c = await session(ch);
    const { data } = await http<{ displayName?: string; avatar?: string }>('Bluesky', `${c.service}/xrpc/app.bsky.actor.getProfile?actor=${c.did}`, { headers: { Authorization: `Bearer ${c.accessJwt}` } });
    return { name: data.displayName || undefined, avatarUrl: data.avatar ?? null, tokenExpiresAt: null };
  },
  async publish(ch, input) {
    const c = await session(ch);
    const auth = { Authorization: `Bearer ${c.accessJwt}` };
    const record: Record<string, unknown> = { $type: 'app.bsky.feed.post', text: input.text, createdAt: new Date().toISOString(), langs: ['en'] };
    const f = await facets(input.text, c.service);
    if (f.length) record.facets = f;
    if (input.media.length) {
      const images = [];
      for (const m of input.media) {
        const { data } = await http<{ blob: unknown }>('Bluesky', `${c.service}/xrpc/com.atproto.repo.uploadBlob`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': m.mime },
          body: await blobOf(m),
          timeoutMs: 60_000,
        });
        images.push({ alt: m.alt || '', image: data.blob });
      }
      record.embed = { $type: 'app.bsky.embed.images', images };
    }
    const { data } = await http<{ uri: string; cid: string }>('Bluesky', `${c.service}/xrpc/com.atproto.repo.createRecord`, {
      headers: auth,
      json: { repo: c.did, collection: 'app.bsky.feed.post', record },
    });
    const rkey = data.uri.split('/').pop();
    return { remoteId: data.uri, url: `https://bsky.app/profile/${ch.handle.replace(/^@/, '')}/post/${rkey}` };
  },
  followUps: 'thread',
  async reply(ch, target, text) {
    const c = await session(ch);
    const auth = { Authorization: `Bearer ${c.accessJwt}` };
    // A reply needs a strong reference (uri + cid) to both the thread root and its parent.
    const ref = async (uri: string) => {
      const [, , repo, collection, rkey] = uri.split('/');
      const { data } = await http<{ uri: string; cid: string }>('Bluesky', `${c.service}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(repo)}&collection=${collection}&rkey=${rkey}`, { headers: auth });
      return { uri: data.uri, cid: data.cid };
    };
    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
      langs: ['en'],
      reply: { root: await ref(target.rootId), parent: await ref(target.parentId) },
    };
    const f = await facets(text, c.service);
    if (f.length) record.facets = f;
    const { data } = await http<{ uri: string }>('Bluesky', `${c.service}/xrpc/com.atproto.repo.createRecord`, { headers: auth, json: { repo: c.did, collection: 'app.bsky.feed.post', record } });
    return { remoteId: data.uri, url: `https://bsky.app/profile/${ch.handle.replace(/^@/, '')}/post/${data.uri.split('/').pop()}` };
  },
  async metrics(ch, uris) {
    const c = await session(ch);
    const out: Record<string, PostMetrics> = {};
    for (let i = 0; i < uris.length; i += 25) {
      const q = uris.slice(i, i + 25).map((u) => `uris=${encodeURIComponent(u)}`).join('&');
      const { data } = await http<{ posts: { uri: string; likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number }[] }>(
        'Bluesky',
        `${c.service}/xrpc/app.bsky.feed.getPosts?${q}`,
        { headers: { Authorization: `Bearer ${c.accessJwt}` } },
      );
      for (const p of data.posts) out[p.uri] = { likes: p.likeCount ?? 0, comments: p.replyCount ?? 0, shares: (p.repostCount ?? 0) + (p.quoteCount ?? 0), views: null };
    }
    return out;
  },
  async followers(ch) {
    const c = await session(ch);
    const { data } = await http<{ followersCount?: number }>('Bluesky', `${c.service}/xrpc/app.bsky.actor.getProfile?actor=${c.did}`, { headers: { Authorization: `Bearer ${c.accessJwt}` } });
    return data.followersCount ?? null;
  },
};
