// Facebook Pages and Instagram professional accounts, both through one Meta app.
// Connecting either one lists every Page the person manages and the Instagram account
// linked to each, and they pick which to add. Page tokens obtained from a long-lived
// user token do not expire, but they stop working if the person changes their password
// or removes the app, which the health check catches.
import { config } from '../config.js';
import { blobOf, http } from './http.js';
import { codepoints } from './text.js';
import { PublishError, type Adapter, type Candidate, type ChannelCtx } from './types.js';

type Creds = { pageToken: string; pageId: string; igUserId?: string };

const V = process.env.META_GRAPH_VERSION || 'v23.0';
const G = `https://graph.facebook.com/${V}`;
// Comment permissions cover first comments now and the inbox later.
const SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'pages_manage_engagement', 'business_management', 'instagram_basic', 'instagram_content_publish', 'instagram_manage_comments'];

/** Graph API errors carry a numeric code that says far more than the HTTP status. */
async function graph<T>(url: string, opts: Parameters<typeof http>[2] = {}): Promise<T> {
  try {
    return (await http<T>('Meta', url, opts)).data;
  } catch (e) {
    if (!(e instanceof PublishError)) throw e;
    const err = e.body?.error;
    const code = Number(err?.code);
    if (code === 190 || code === 102 || err?.type === 'OAuthException' && code !== 4) {
      e.kind = 'auth';
      e.code = 'token_invalid';
      e.hint = 'The Facebook connection is no longer valid (password change, removed permission or expired session). Reconnect this channel.';
    } else if ([4, 17, 32, 613, 80001, 80002].includes(code)) {
      e.kind = 'temporary';
      e.code = 'rate_limited';
      e.hint = 'Meta is rate limiting this account. Surecast will retry later.';
    } else if (code === 10 || code === 200) {
      e.kind = 'auth';
      e.code = 'permission';
      e.hint = 'Surecast is missing a permission on this Page. Reconnect and approve every permission requested.';
    } else if (code === 368) {
      e.kind = 'permanent';
      e.code = 'blocked';
      e.hint = 'Meta has temporarily blocked this account from posting (often for spam signals). Check notifications on the account.';
    } else if (code === 9004 || code === 2207052 || code === 36003) {
      e.kind = 'permanent';
      e.code = 'media_rejected';
      e.hint = 'Instagram could not use this image. Use a JPEG with an aspect ratio between 4:5 and 1.91:1.';
    } else if (err?.is_transient) e.kind = 'temporary';
    throw e;
  }
}

const oauth: Adapter['connect'] = {
  kind: 'oauth',
  help: 'You will be sent to Facebook to choose the Pages (and linked Instagram accounts) Surecast may post to.',
  async start({ state, redirectUri }) {
    const q = new URLSearchParams({ client_id: config.meta!.id, redirect_uri: redirectUri, state, scope: SCOPES.join(','), response_type: 'code' });
    return { url: `https://www.facebook.com/${V}/dialog/oauth?${q}` };
  },
  async finish({ code, redirectUri }) {
    const short = await graph<{ access_token: string }>(
      `${G}/oauth/access_token?${new URLSearchParams({ client_id: config.meta!.id, client_secret: config.meta!.secret, redirect_uri: redirectUri, code })}`,
    );
    const long = await graph<{ access_token: string }>(
      `${G}/oauth/access_token?${new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: config.meta!.id, client_secret: config.meta!.secret, fb_exchange_token: short.access_token })}`,
    );
    const pages = await graph<{ data: { id: string; name: string; access_token: string; picture?: { data?: { url?: string } }; instagram_business_account?: { id: string; username?: string; profile_picture_url?: string } }[] }>(
      `${G}/me/accounts?fields=id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}&limit=100&access_token=${long.access_token}`,
    );
    const out: Candidate[] = [];
    for (const p of pages.data) {
      out.push({ platform: 'facebook', name: p.name, handle: p.name, externalId: p.id, avatarUrl: p.picture?.data?.url ?? null, credentials: { pageToken: p.access_token, pageId: p.id } satisfies Creds, tokenExpiresAt: null, detail: 'Facebook Page' });
      const ig = p.instagram_business_account;
      if (ig)
        out.push({
          platform: 'instagram',
          name: ig.username ? `@${ig.username}` : `${p.name} (Instagram)`,
          handle: ig.username ? `@${ig.username}` : '',
          externalId: ig.id,
          avatarUrl: ig.profile_picture_url ?? null,
          credentials: { pageToken: p.access_token, pageId: p.id, igUserId: ig.id } satisfies Creds,
          tokenExpiresAt: null,
          detail: `Instagram, linked to ${p.name}`,
        });
    }
    if (!out.length) throw new PublishError('permanent', 'no_pages', 'No Facebook Pages were shared with Surecast', 'Connect again and tick at least one Page in the Facebook dialog.');
    return out;
  },
};

const unavailableReason = 'Facebook and Instagram need a Meta app that has passed App Review. Add META_APP_ID and META_APP_SECRET to switch them on.';

export const facebook: Adapter = {
  platform: 'facebook',
  label: 'Facebook Page',
  limits: { maxChars: 63_206, maxImages: 10, maxImageBytes: 10_000_000, imageTypes: ['image/jpeg', 'image/png', 'image/gif'] },
  available: () => !!config.meta,
  unavailableReason,
  count: codepoints,
  connect: oauth,
  async check(ch) {
    const c = ch.credentials as Creds;
    const page = await graph<{ name: string }>(`${G}/${c.pageId}?fields=name&access_token=${c.pageToken}`);
    return { name: page.name };
  },
  async publish(ch, input) {
    const c = ch.credentials as Creds;
    const upload = async (m: (typeof input.media)[number], published: boolean, caption?: string) => {
      const form = new FormData();
      form.append('access_token', c.pageToken);
      form.append('published', String(published));
      if (caption) form.append('caption', caption);
      form.append('source', await blobOf(m), m.filename);
      return graph<{ id: string; post_id?: string }>(`${G}/${c.pageId}/photos`, { method: 'POST', body: form, timeoutMs: 90_000 });
    };
    let postId: string;
    if (input.media.length === 1) {
      const r = await upload(input.media[0], true, input.text);
      postId = r.post_id ?? r.id;
    } else {
      const attached = [];
      for (const m of input.media) attached.push({ media_fbid: (await upload(m, false)).id });
      const r = await graph<{ id: string }>(`${G}/${c.pageId}/feed`, { json: { message: input.text, attached_media: attached.length ? attached : undefined, access_token: c.pageToken } });
      postId = r.id;
    }
    return { remoteId: postId, url: `https://www.facebook.com/${postId}` };
  },
  followUps: 'comment',
  async reply(ch, target, text) {
    const c = ch.credentials as Creds;
    const r = await graph<{ id: string }>(`${G}/${target.rootId}/comments`, { json: { message: text, access_token: c.pageToken } });
    return { remoteId: r.id, url: `https://www.facebook.com/${target.rootId}` };
  },
};

async function waitForContainer(id: string, token: string) {
  for (let i = 0; i < 30; i++) {
    const s = await graph<{ status_code: string; status?: string }>(`${G}/${id}?fields=status_code,status&access_token=${token}`);
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED')
      throw new PublishError('permanent', 'media_rejected', `Instagram could not process the media: ${s.status ?? s.status_code}`, 'Use a JPEG with an aspect ratio between 4:5 and 1.91:1, under 8 MB.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new PublishError('temporary', 'media_processing', 'Instagram is still processing the media', 'Surecast will retry shortly.');
}

export const instagram: Adapter = {
  platform: 'instagram',
  label: 'Instagram',
  // Instagram's publishing API only accepts JPEG images, fetched from a public URL.
  limits: { maxChars: 2200, maxImages: 10, maxImageBytes: 8_000_000, imageTypes: ['image/jpeg'], requiresMedia: true },
  available: () => !!config.meta,
  unavailableReason,
  count: codepoints,
  connect: oauth,
  async check(ch: ChannelCtx) {
    const c = ch.credentials as Creds;
    const ig = await graph<{ username: string; profile_picture_url?: string }>(`${G}/${c.igUserId}?fields=username,profile_picture_url&access_token=${c.pageToken}`);
    return { name: `@${ig.username}`, avatarUrl: ig.profile_picture_url ?? null };
  },
  async publish(ch, input) {
    const c = ch.credentials as Creds;
    const t = c.pageToken;
    let creationId: string;
    if (input.media.length === 1) {
      creationId = (await graph<{ id: string }>(`${G}/${c.igUserId}/media`, { json: { image_url: input.media[0].url, caption: input.text, alt_text: input.media[0].alt || undefined, access_token: t } })).id;
    } else {
      const children = [];
      for (const m of input.media) {
        const child = await graph<{ id: string }>(`${G}/${c.igUserId}/media`, { json: { image_url: m.url, is_carousel_item: true, alt_text: m.alt || undefined, access_token: t } });
        children.push(child.id);
      }
      for (const id of children) await waitForContainer(id, t);
      creationId = (await graph<{ id: string }>(`${G}/${c.igUserId}/media`, { json: { media_type: 'CAROUSEL', children: children.join(','), caption: input.text, access_token: t } })).id;
    }
    await waitForContainer(creationId, t);
    const published = await graph<{ id: string }>(`${G}/${c.igUserId}/media_publish`, { json: { creation_id: creationId, access_token: t } });
    let url: string | null = null;
    try {
      url = (await graph<{ permalink: string }>(`${G}/${published.id}?fields=permalink&access_token=${t}`)).permalink;
    } catch {
      /* the post is live; the link is a nice-to-have */
    }
    return { remoteId: published.id, url };
  },
  followUps: 'comment',
  async reply(ch, target, text) {
    const c = ch.credentials as Creds;
    const r = await graph<{ id: string }>(`${G}/${target.rootId}/comments`, { json: { message: text, access_token: c.pageToken } });
    return { remoteId: r.id, url: null };
  },
};
