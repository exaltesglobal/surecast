// YouTube, through the Data API v3. Each channel the Google account manages is its own
// Surecast channel. A post is one video: the first line of the text is the title and the rest
// the description. Vertical videos under three minutes show up as Shorts. Uses the same Google
// Cloud app as Google Business Profile. Until Google audits the app, uploads stay private.
import { config } from '../config.js';
import { blobOf, http } from './http.js';
import { codepoints } from './text.js';
import { PublishError, type Adapter, type ChannelCtx, type PostMetrics, type RemoteComment } from './types.js';

type Creds = { accessToken: string; refreshToken: string; channelId: string };

const API = 'https://www.googleapis.com/youtube/v3';
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/youtube.force-ssl'];

/** Quota and upload limits reset daily, so they are worth retrying rather than failing the post. */
async function yt<T>(url: string, opts: Parameters<typeof http>[2] = {}) {
  try {
    return await http<T>('YouTube', url, opts);
  } catch (e) {
    if (e instanceof PublishError) {
      const reason = e.body?.error?.errors?.[0]?.reason as string | undefined;
      if (reason && ['quotaExceeded', 'uploadLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) {
        e.kind = 'temporary';
        e.code = 'rate_limited';
        e.hint = 'YouTube limits how much an app or channel can upload each day. Surecast will try again in an hour.';
        e.retryAfter = new Date(Date.now() + 3_600_000);
      } else if (reason === 'youtubeSignupRequired') {
        e.kind = 'auth';
        e.hint = 'This Google account has no YouTube channel yet. Create one on YouTube, then reconnect.';
      }
    }
    throw e;
  }
}

async function token(ch: ChannelCtx) {
  const c = ch.credentials as Creds;
  if (ch.tokenExpiresAt && ch.tokenExpiresAt.getTime() > Date.now() + 5 * 60_000) return c.accessToken;
  try {
    const { data } = await http<{ access_token: string; expires_in: number }>('YouTube', 'https://oauth2.googleapis.com/token', {
      form: { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: config.google!.id, client_secret: config.google!.secret },
    });
    await ch.saveCredentials({ ...c, accessToken: data.access_token }, new Date(Date.now() + data.expires_in * 1000));
    return data.access_token;
  } catch (e) {
    if (e instanceof PublishError && (e.httpStatus === 400 || e.httpStatus === 401)) {
      e.kind = 'auth';
      e.hint = 'Google no longer accepts this connection (access was removed or the password changed). Reconnect this channel.';
    }
    throw e;
  }
}

/** YouTube rejects angle brackets in titles and descriptions. */
const clean = (s: string) => s.replace(/[<>]/g, '');

export function videoParts(text: string) {
  const lines = text.trim().split('\n');
  const title = clean(lines[0]).trim().slice(0, 100) || 'New video';
  const description = clean(lines.slice(1).join('\n')).trim().slice(0, 5000);
  return { title, description };
}

type Channel = { id: string; snippet: { title: string; customUrl?: string; thumbnails?: { default?: { url: string } } }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean } };

export const youtube: Adapter = {
  platform: 'youtube',
  label: 'YouTube',
  limits: {
    maxChars: 5000,
    maxImages: 0,
    maxImageBytes: 0,
    imageTypes: [],
    videoTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    maxVideoBytes: 100_000_000,
    requiresVideo: true,
  },
  available: () => !!config.google,
  unavailableReason: 'YouTube needs a Google Cloud app with the YouTube Data API switched on. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to switch it on.',
  count: codepoints,
  connect: {
    kind: 'oauth',
    help: 'You will be sent to Google to approve Surecast, then pick the YouTube channels to post to. The first line of a post becomes the video title.',
    async start({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: config.google!.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` };
    },
    async finish({ code, redirectUri }) {
      const tok = await http<{ access_token: string; refresh_token?: string; expires_in: number }>('YouTube', 'https://oauth2.googleapis.com/token', {
        form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.google!.id, client_secret: config.google!.secret },
      });
      if (!tok.data.refresh_token) throw new PublishError('permanent', 'no_refresh', 'Google did not grant offline access', 'Remove Surecast from your Google account permissions, then connect again.');
      const { data } = await yt<{ items?: Channel[] }>(`${API}/channels?part=snippet&mine=true&maxResults=50`, { headers: { Authorization: `Bearer ${tok.data.access_token}` } });
      if (!data.items?.length) throw new PublishError('permanent', 'no_channel', 'This Google account has no YouTube channel', 'Create a channel on YouTube, or sign in with the account that owns it.');
      return data.items.map((ch) => ({
        platform: 'youtube' as const,
        name: ch.snippet.title,
        handle: ch.snippet.customUrl ?? ch.id,
        externalId: ch.id,
        avatarUrl: ch.snippet.thumbnails?.default?.url ?? null,
        credentials: { accessToken: tok.data.access_token, refreshToken: tok.data.refresh_token!, channelId: ch.id } satisfies Creds,
        tokenExpiresAt: new Date(Date.now() + tok.data.expires_in * 1000),
        detail: 'YouTube channel',
      }));
    },
  },
  async check(ch) {
    const t = await token(ch);
    const { data } = await yt<{ items?: Channel[] }>(`${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${t}` } });
    const mine = data.items?.find((x) => x.id === (ch.credentials as Creds).channelId) ?? data.items?.[0];
    if (!mine) throw new PublishError('auth', 'no_channel', 'YouTube no longer shows this channel for the connected account', 'Reconnect with the Google account that owns the channel.');
    // The access token lasts an hour and refreshes itself, so there is no expiry to warn about.
    return { name: mine.snippet.title, avatarUrl: mine.snippet.thumbnails?.default?.url ?? null, tokenExpiresAt: null };
  },
  async publish(ch, input) {
    const video = input.media.find((m) => m.mime.startsWith('video/'));
    if (!video) throw new PublishError('permanent', 'no_video', 'YouTube posts need a video', 'Add a video to this post.');
    const t = await token(ch);
    const { title, description } = videoParts(input.text);
    const init = await yt<unknown>(`${API.replace('/youtube/v3', '/upload/youtube/v3')}/videos?uploadType=resumable&part=snippet,status`, {
      headers: { Authorization: `Bearer ${t}`, 'X-Upload-Content-Type': video.mime, 'X-Upload-Content-Length': String(video.size) },
      json: { snippet: { title, description, categoryId: '22' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } },
    });
    const location = init.headers.get('location');
    if (!location) throw new PublishError('temporary', 'no_upload_url', 'YouTube did not return an upload address', 'Surecast will retry automatically.');
    const { data } = await yt<{ id: string; status?: { privacyStatus?: string } }>(location, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': video.mime },
      body: await blobOf(video),
      timeoutMs: 4 * 60_000,
    });
    return { remoteId: data.id, url: `https://www.youtube.com/watch?v=${data.id}` };
  },
  followUps: 'comment',
  async reply(ch, target, text) {
    const t = await token(ch);
    const { data } = await yt<{ id: string }>(`${API}/commentThreads?part=snippet`, {
      headers: { Authorization: `Bearer ${t}` },
      json: { snippet: { videoId: target.rootId, topLevelComment: { snippet: { textOriginal: text } } } },
    });
    return { remoteId: data.id, url: `https://www.youtube.com/watch?v=${target.rootId}&lc=${data.id}` };
  },
  async metrics(ch, ids) {
    const t = await token(ch);
    const out: Record<string, PostMetrics> = {};
    for (let i = 0; i < ids.length; i += 50) {
      const { data } = await yt<{ items?: { id: string; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(
        `${API}/videos?part=statistics&id=${ids.slice(i, i + 50).map(encodeURIComponent).join(',')}`,
        { headers: { Authorization: `Bearer ${t}` } },
      );
      for (const v of data.items ?? [])
        out[v.id] = { likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0), shares: 0, views: v.statistics?.viewCount ? Number(v.statistics.viewCount) : null };
    }
    return out;
  },
  async followers(ch) {
    const t = await token(ch);
    const { data } = await yt<{ items?: Channel[] }>(`${API}/channels?part=statistics&id=${(ch.credentials as Creds).channelId}`, { headers: { Authorization: `Bearer ${t}` } });
    const s = data.items?.[0]?.statistics;
    return !s || s.hiddenSubscriberCount ? null : Number(s.subscriberCount ?? 0);
  },
  async comments(ch, ids) {
    const t = await token(ch);
    const own = (ch.credentials as Creds).channelId;
    const out: Record<string, RemoteComment[]> = {};
    type S = { authorDisplayName: string; authorProfileImageUrl?: string; authorChannelId?: { value: string }; authorChannelUrl?: string; textOriginal: string; publishedAt: string };
    for (const id of ids) {
      try {
        const { data } = await yt<{ items?: { id: string; snippet: { topLevelComment: { id: string; snippet: S } } }[] }>(
          `${API}/commentThreads?part=snippet&videoId=${encodeURIComponent(id)}&maxResults=100&order=time&textFormat=plainText`,
          { headers: { Authorization: `Bearer ${t}` } },
        );
        out[id] = (data.items ?? [])
          .map((th) => th.snippet.topLevelComment)
          .filter((c) => c.snippet.authorChannelId?.value !== own)
          .map((c) => ({
            id: c.id,
            parentId: id,
            authorName: c.snippet.authorDisplayName,
            authorHandle: c.snippet.authorDisplayName,
            authorAvatar: c.snippet.authorProfileImageUrl ?? null,
            text: c.snippet.textOriginal,
            createdAt: new Date(c.snippet.publishedAt),
            url: `https://www.youtube.com/watch?v=${id}&lc=${c.id}`,
          }));
      } catch (e) {
        // Comments switched off on a video come back as 403 commentsDisabled; skip that video.
        if (!(e instanceof PublishError) || e.body?.error?.errors?.[0]?.reason !== 'commentsDisabled') throw e;
      }
    }
    return out;
  },
  async answer(ch, comment, text) {
    const t = await token(ch);
    const { data } = await yt<{ id: string }>(`${API}/comments?part=snippet`, { headers: { Authorization: `Bearer ${t}` }, json: { snippet: { parentId: comment.id, textOriginal: text } } });
    return { remoteId: data.id, url: `https://www.youtube.com/watch?v=${comment.rootId}&lc=${data.id}` };
  },
};
