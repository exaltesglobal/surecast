// Pinterest, through API v5. Each board is its own channel, so a client can post to the
// boards that fit each post. Every Pin needs an image; the first line of the text becomes
// the title, the rest the description, and the first link in the text becomes the Pin's link.
import { config } from '../config.js';
import { http } from './http.js';
import { codepoints, URL_RE } from './text.js';
import { PublishError, type Adapter, type ChannelCtx, type PostMetrics } from './types.js';

type Creds = { accessToken: string; refreshToken: string; boardId: string; username: string };

const API = 'https://api.pinterest.com/v5';
const basic = () => `Basic ${Buffer.from(`${config.pinterest!.id}:${config.pinterest!.secret}`).toString('base64')}`;

async function token(ch: ChannelCtx) {
  const c = ch.credentials as Creds;
  // Refreshed with over a week to spare, so the health check never sees a token about to expire.
  if (ch.tokenExpiresAt && ch.tokenExpiresAt.getTime() > Date.now() + 8 * 86_400_000) return c.accessToken;
  try {
    const { data } = await http<{ access_token: string; refresh_token?: string; expires_in: number }>('Pinterest', `${API}/oauth/token`, {
      headers: { Authorization: basic() },
      form: { grant_type: 'refresh_token', refresh_token: c.refreshToken },
    });
    await ch.saveCredentials({ ...c, accessToken: data.access_token, refreshToken: data.refresh_token ?? c.refreshToken }, new Date(Date.now() + data.expires_in * 1000));
    return data.access_token;
  } catch (e) {
    if (e instanceof PublishError && (e.httpStatus === 400 || e.httpStatus === 401)) {
      e.kind = 'auth';
      e.hint = 'Pinterest no longer accepts this connection. Reconnect this channel.';
    }
    throw e;
  }
}

/** Title from the first line, description from the rest, link from the first URL. */
export function pinParts(text: string) {
  const link = text.match(URL_RE)?.[0];
  const lines = text.trim().split('\n');
  const title = lines[0].replace(URL_RE, '').trim().slice(0, 100);
  const description = (lines.length > 1 ? lines.slice(1).join('\n') : lines[0]).trim().slice(0, 800);
  return { title, description, link };
}

export const pinterest: Adapter = {
  platform: 'pinterest',
  label: 'Pinterest',
  limits: { maxChars: 800, maxImages: 5, maxImageBytes: 20_000_000, imageTypes: ['image/jpeg', 'image/png', 'image/webp'], requiresMedia: true },
  available: () => !!config.pinterest,
  unavailableReason: 'Pinterest needs a developer app with Standard access. Add PINTEREST_APP_ID and PINTEREST_APP_SECRET to switch it on.',
  count: codepoints,
  connect: {
    kind: 'oauth',
    help: 'You will be sent to Pinterest to approve Surecast, then pick the boards to post to.',
    async start({ state, redirectUri }) {
      const q = new URLSearchParams({ client_id: config.pinterest!.id, redirect_uri: redirectUri, response_type: 'code', scope: 'boards:read,pins:read,pins:write,user_accounts:read', state });
      return { url: `https://www.pinterest.com/oauth/?${q}` };
    },
    async finish({ code, redirectUri }) {
      const tok = await http<{ access_token: string; refresh_token: string; expires_in: number }>('Pinterest', `${API}/oauth/token`, {
        headers: { Authorization: basic() },
        form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
      });
      const auth = { Authorization: `Bearer ${tok.data.access_token}` };
      const me = await http<{ username: string; profile_image?: string }>('Pinterest', `${API}/user_account`, { headers: auth });
      const boards = await http<{ items: { id: string; name: string; privacy?: string }[] }>('Pinterest', `${API}/boards?page_size=100`, { headers: auth });
      if (!boards.data.items.length) throw new PublishError('permanent', 'no_boards', 'This Pinterest account has no boards', 'Create a board on Pinterest, then connect again.');
      return boards.data.items.map((b) => ({
        platform: 'pinterest' as const,
        name: b.name,
        handle: `@${me.data.username}`,
        externalId: b.id,
        avatarUrl: me.data.profile_image ?? null,
        credentials: { accessToken: tok.data.access_token, refreshToken: tok.data.refresh_token, boardId: b.id, username: me.data.username } satisfies Creds,
        tokenExpiresAt: new Date(Date.now() + tok.data.expires_in * 1000),
        detail: `Board${b.privacy === 'SECRET' ? ' (secret)' : ''} on @${me.data.username}`,
      }));
    },
  },
  async check(ch) {
    const t = await token(ch);
    const c = ch.credentials as Creds;
    const b = await http<{ name: string }>('Pinterest', `${API}/boards/${c.boardId}`, { headers: { Authorization: `Bearer ${t}` } });
    return { name: b.data.name };
  },
  async publish(ch, input) {
    const t = await token(ch);
    const c = ch.credentials as Creds;
    const { title, description, link } = pinParts(input.text);
    const media_source =
      input.media.length === 1
        ? { source_type: 'image_url', url: input.media[0].url }
        : { source_type: 'multiple_image_urls', items: input.media.map((m) => ({ url: m.url, title: title || undefined, description: m.alt || undefined })) };
    const { data } = await http<{ id: string }>('Pinterest', `${API}/pins`, {
      headers: { Authorization: `Bearer ${t}` },
      json: { board_id: c.boardId, title: title || undefined, description, link, alt_text: input.media[0]?.alt?.slice(0, 500) || undefined, media_source },
    });
    return { remoteId: data.id, url: `https://www.pinterest.com/pin/${data.id}/` };
  },
  async metrics(ch, ids) {
    const t = await token(ch);
    const out: Record<string, PostMetrics> = {};
    type M = { impression?: number; save?: number; pin_click?: number; outbound_click?: number; reaction?: number; comment?: number };
    for (const id of ids) {
      try {
        const { data } = await http<{ pin_metrics?: { lifetime_metrics?: M } }>('Pinterest', `${API}/pins/${id}?pin_metrics=true`, { headers: { Authorization: `Bearer ${t}` } });
        const m = data.pin_metrics?.lifetime_metrics ?? {};
        out[id] = { likes: m.reaction ?? 0, comments: m.comment ?? 0, shares: m.save ?? 0, views: m.impression ?? null };
      } catch (e) {
        if (!(e instanceof PublishError) || e.httpStatus !== 404) throw e;
      }
    }
    return out;
  },
  async followers(ch) {
    const { data } = await http<{ follower_count?: number }>('Pinterest', `${API}/user_account`, { headers: { Authorization: `Bearer ${await token(ch)}` } });
    return data.follower_count ?? null;
  },
};
