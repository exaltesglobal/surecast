// Threads (Meta), through the Threads API. Needs a Meta app with the Threads use case.
// Long-lived tokens last 60 days and are refreshed automatically well before they run out.
// Images are fetched by Threads from Surecast's public media links, like Instagram.
import { config } from '../config.js';
import { http } from './http.js';
import { codepoints } from './text.js';
import { PublishError, type Adapter, type ChannelCtx, type PostMetrics, type RemoteComment } from './types.js';

type Creds = { accessToken: string; userId: string; username: string };

const G = 'https://graph.threads.net/v1.0';
const SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_read_replies', 'threads_manage_insights'];
const DAY = 86_400_000;

async function api<T>(url: string, opts: Parameters<typeof http>[2] = {}): Promise<T> {
  try {
    return (await http<T>('Threads', url, opts)).data;
  } catch (e) {
    if (e instanceof PublishError) {
      const code = Number(e.body?.error?.code);
      if (code === 190) {
        e.kind = 'auth';
        e.code = 'token_invalid';
        e.hint = 'The Threads connection is no longer valid. Reconnect this channel.';
      } else if ([4, 17, 32, 613].includes(code)) {
        e.kind = 'temporary';
        e.code = 'rate_limited';
        e.hint = 'Threads is rate limiting this account (250 posts a day). Surecast will retry later.';
      }
    }
    throw e;
  }
}

/** Refreshes the long-lived token with over a week to spare, so the health check never warns about it. */
async function token(ch: ChannelCtx) {
  const c = ch.credentials as Creds;
  if (!ch.tokenExpiresAt || ch.tokenExpiresAt.getTime() > Date.now() + 8 * DAY) return c.accessToken;
  const r = await api<{ access_token: string; expires_in: number }>(`https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${c.accessToken}`);
  await ch.saveCredentials({ ...c, accessToken: r.access_token }, new Date(Date.now() + r.expires_in * 1000));
  return r.access_token;
}

async function waitForContainer(id: string, t: string) {
  for (let i = 0; i < 30; i++) {
    const s = await api<{ status: string; error_message?: string }>(`${G}/${id}?fields=status,error_message&access_token=${t}`);
    if (s.status === 'FINISHED') return;
    if (s.status === 'ERROR' || s.status === 'EXPIRED')
      throw new PublishError('permanent', 'media_rejected', `Threads could not process the post: ${s.error_message ?? s.status}`, 'Use JPEG or PNG images under 8 MB.');
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new PublishError('temporary', 'media_processing', 'Threads is still processing the post', 'Surecast will retry shortly.');
}

async function create(c: Creds, t: string, text: string, media: { url: string; alt: string }[], replyTo?: string) {
  const base = { access_token: t, ...(replyTo ? { reply_to_id: replyTo } : {}) };
  let creation: string;
  if (media.length === 0) creation = (await api<{ id: string }>(`${G}/${c.userId}/threads`, { json: { ...base, media_type: 'TEXT', text } })).id;
  else if (media.length === 1)
    creation = (await api<{ id: string }>(`${G}/${c.userId}/threads`, { json: { ...base, media_type: 'IMAGE', image_url: media[0].url, alt_text: media[0].alt || undefined, text } })).id;
  else {
    const children: string[] = [];
    for (const m of media)
      children.push((await api<{ id: string }>(`${G}/${c.userId}/threads`, { json: { access_token: t, media_type: 'IMAGE', image_url: m.url, alt_text: m.alt || undefined, is_carousel_item: true } })).id);
    for (const id of children) await waitForContainer(id, t);
    creation = (await api<{ id: string }>(`${G}/${c.userId}/threads`, { json: { ...base, media_type: 'CAROUSEL', children: children.join(','), text } })).id;
  }
  await waitForContainer(creation, t);
  const published = await api<{ id: string }>(`${G}/${c.userId}/threads_publish`, { json: { access_token: t, creation_id: creation } });
  let url: string | null = null;
  try {
    url = (await api<{ permalink: string }>(`${G}/${published.id}?fields=permalink&access_token=${t}`)).permalink;
  } catch {
    /* the post is live; the link is a nice-to-have */
  }
  return { remoteId: published.id, url };
}

export const threads: Adapter = {
  platform: 'threads',
  label: 'Threads',
  limits: { maxChars: 500, maxImages: 20, maxImageBytes: 8_000_000, imageTypes: ['image/jpeg', 'image/png'] },
  available: () => !!config.threads,
  unavailableReason: 'Threads needs a Meta app with the Threads use case. Add THREADS_APP_ID and THREADS_APP_SECRET to switch it on.',
  count: codepoints,
  connect: {
    kind: 'oauth',
    help: 'You will be sent to Threads to approve Surecast.',
    async start({ state, redirectUri }) {
      const q = new URLSearchParams({ client_id: config.threads!.id, redirect_uri: redirectUri, scope: SCOPES.join(','), response_type: 'code', state });
      return { url: `https://threads.net/oauth/authorize?${q}` };
    },
    async finish({ code, redirectUri }) {
      const short = await api<{ access_token: string; user_id: string | number }>('https://graph.threads.net/oauth/access_token', {
        form: { client_id: config.threads!.id, client_secret: config.threads!.secret, grant_type: 'authorization_code', redirect_uri: redirectUri, code },
      });
      const long = await api<{ access_token: string; expires_in: number }>(
        `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${config.threads!.secret}&access_token=${short.access_token}`,
      );
      const me = await api<{ id: string; username: string; name?: string; threads_profile_picture_url?: string }>(`${G}/me?fields=id,username,name,threads_profile_picture_url&access_token=${long.access_token}`);
      return [
        {
          platform: 'threads',
          name: me.name || `@${me.username}`,
          handle: `@${me.username}`,
          externalId: me.id,
          avatarUrl: me.threads_profile_picture_url ?? null,
          credentials: { accessToken: long.access_token, userId: me.id, username: me.username } satisfies Creds,
          tokenExpiresAt: new Date(Date.now() + long.expires_in * 1000),
        },
      ];
    },
  },
  async check(ch) {
    const t = await token(ch);
    const me = await api<{ name?: string; threads_profile_picture_url?: string }>(`${G}/me?fields=name,threads_profile_picture_url&access_token=${t}`);
    return { name: me.name, avatarUrl: me.threads_profile_picture_url ?? null };
  },
  async publish(ch, input) {
    return create(ch.credentials as Creds, await token(ch), input.text, input.media);
  },
  followUps: 'thread',
  async reply(ch, target, text) {
    return create(ch.credentials as Creds, await token(ch), text, [], target.parentId);
  },
  async metrics(ch, ids) {
    const t = await token(ch);
    const out: Record<string, PostMetrics> = {};
    for (const id of ids) {
      try {
        const r = await api<{ data: { name: string; values?: { value: number }[] }[] }>(`${G}/${id}/insights?metric=views,likes,replies,reposts,quotes&access_token=${t}`);
        const v = (n: string) => r.data.find((d) => d.name === n)?.values?.[0]?.value ?? 0;
        out[id] = { likes: v('likes'), comments: v('replies'), shares: v('reposts') + v('quotes'), views: v('views') };
      } catch (e) {
        if (!(e instanceof PublishError) || e.httpStatus !== 400) throw e;
      }
    }
    return out;
  },
  async followers(ch) {
    const c = ch.credentials as Creds;
    const r = await api<{ data: { name: string; total_value?: { value: number } }[] }>(`${G}/${c.userId}/threads_insights?metric=followers_count&access_token=${await token(ch)}`);
    return r.data.find((d) => d.name === 'followers_count')?.total_value?.value ?? null;
  },
  async comments(ch, ids) {
    const c = ch.credentials as Creds;
    const t = await token(ch);
    const out: Record<string, RemoteComment[]> = {};
    type R = { id: string; text?: string; username?: string; timestamp: string; permalink?: string; replied_to?: { id: string } };
    for (const id of ids) {
      const r = await api<{ data: R[] }>(`${G}/${id}/conversation?fields=id,text,username,timestamp,permalink,replied_to&access_token=${t}`);
      out[id] = r.data
        .filter((x) => x.username !== c.username)
        .map((x) => ({ id: x.id, parentId: x.replied_to?.id ?? id, authorName: x.username ?? 'Threads user', authorHandle: x.username ? `@${x.username}` : '', authorAvatar: null, text: x.text ?? '', createdAt: new Date(x.timestamp), url: x.permalink ?? null }));
    }
    return out;
  },
};
