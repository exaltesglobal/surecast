// X (Twitter), through the v2 API with OAuth 2.0 and PKCE. Needs an X developer app on a
// plan that allows posting. Access tokens last two hours and are refreshed automatically.
import { createHash, randomBytes } from 'node:crypto';

import { config } from '../config.js';
import { blobOf, http } from './http.js';
import { xLength } from './text.js';
import { PublishError, type Adapter, type ChannelCtx, type PostMetrics } from './types.js';

type Creds = { accessToken: string; refreshToken: string; username: string };

const basic = () => `Basic ${Buffer.from(`${config.x!.id}:${config.x!.secret}`).toString('base64')}`;

async function token(ch: ChannelCtx): Promise<string> {
  const c = ch.credentials as Creds;
  if (ch.tokenExpiresAt && ch.tokenExpiresAt.getTime() > Date.now() + 5 * 60_000) return c.accessToken;
  try {
    const { data } = await http<{ access_token: string; refresh_token: string; expires_in: number }>('X', 'https://api.x.com/2/oauth2/token', {
      headers: { Authorization: basic() },
      form: { grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: config.x!.id },
    });
    await ch.saveCredentials({ ...c, accessToken: data.access_token, refreshToken: data.refresh_token }, new Date(Date.now() + data.expires_in * 1000));
    return data.access_token;
  } catch (e) {
    if (e instanceof PublishError && (e.httpStatus === 400 || e.httpStatus === 401)) {
      e.kind = 'auth';
      e.hint = 'X no longer accepts this connection (it was revoked or unused for too long). Reconnect this channel.';
    }
    throw e;
  }
}

export const x: Adapter = {
  platform: 'x',
  label: 'X',
  limits: { maxChars: 280, maxImages: 4, maxImageBytes: 5_000_000, imageTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] },
  available: () => !!config.x,
  unavailableReason: 'X needs a developer app on a paid API plan. Add X_CLIENT_ID and X_CLIENT_SECRET to switch it on.',
  count: xLength,
  connect: {
    kind: 'oauth',
    help: 'You will be sent to X to approve Surecast.',
    async start({ state, redirectUri }) {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const q = new URLSearchParams({
        response_type: 'code',
        client_id: config.x!.id,
        redirect_uri: redirectUri,
        scope: 'tweet.read tweet.write users.read media.write offline.access',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return { url: `https://x.com/i/oauth2/authorize?${q}`, data: { verifier } };
    },
    async finish({ code, redirectUri, data }) {
      const tok = await http<{ access_token: string; refresh_token: string; expires_in: number }>('X', 'https://api.x.com/2/oauth2/token', {
        headers: { Authorization: basic() },
        form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: String(data.verifier), client_id: config.x!.id },
      });
      const me = await http<{ data: { id: string; name: string; username: string; profile_image_url?: string } }>('X', 'https://api.x.com/2/users/me?user.fields=profile_image_url', {
        headers: { Authorization: `Bearer ${tok.data.access_token}` },
      });
      const u = me.data.data;
      return [
        {
          platform: 'x',
          name: u.name,
          handle: `@${u.username}`,
          externalId: u.id,
          avatarUrl: u.profile_image_url ?? null,
          credentials: { accessToken: tok.data.access_token, refreshToken: tok.data.refresh_token, username: u.username } satisfies Creds,
          tokenExpiresAt: new Date(Date.now() + tok.data.expires_in * 1000),
        },
      ];
    },
  },
  async check(ch) {
    const t = await token(ch);
    const { data } = await http<{ data: { name: string; profile_image_url?: string } }>('X', 'https://api.x.com/2/users/me?user.fields=profile_image_url', { headers: { Authorization: `Bearer ${t}` } });
    // Report no expiry: the refresh token keeps the connection alive.
    return { name: data.data.name, avatarUrl: data.data.profile_image_url ?? null, tokenExpiresAt: null };
  },
  async publish(ch, input) {
    const t = await token(ch);
    const auth = { Authorization: `Bearer ${t}` };
    const mediaIds: string[] = [];
    for (const m of input.media) {
      const form = new FormData();
      form.append('media', await blobOf(m), m.filename);
      form.append('media_category', 'tweet_image');
      const { data } = await http<{ data: { id: string } }>('X', 'https://api.x.com/2/media/upload', { method: 'POST', headers: auth, body: form, timeoutMs: 90_000 });
      mediaIds.push(data.data.id);
    }
    try {
      const { data } = await http<{ data: { id: string } }>('X', 'https://api.x.com/2/tweets', {
        headers: auth,
        json: { text: input.text, ...(mediaIds.length ? { media: { media_ids: mediaIds } } : {}) },
      });
      const username = (ch.credentials as Creds).username;
      return { remoteId: data.data.id, url: `https://x.com/${username}/status/${data.data.id}` };
    } catch (e) {
      if (e instanceof PublishError && /duplicate/i.test(e.message)) {
        e.kind = 'permanent';
        e.code = 'duplicate';
        e.hint = 'X does not allow posting the same text twice. Change the wording and try again.';
      }
      throw e;
    }
  },
  followUps: 'thread',
  async reply(ch, target, text) {
    const t = await token(ch);
    const { data } = await http<{ data: { id: string } }>('X', 'https://api.x.com/2/tweets', {
      headers: { Authorization: `Bearer ${t}` },
      json: { text, reply: { in_reply_to_tweet_id: target.parentId } },
    });
    return { remoteId: data.data.id, url: `https://x.com/${(ch.credentials as Creds).username}/status/${data.data.id}` };
  },
  async metrics(ch, ids) {
    const t = await token(ch);
    const out: Record<string, PostMetrics> = {};
    for (let i = 0; i < ids.length; i += 100) {
      type M = { like_count: number; reply_count: number; retweet_count: number; quote_count: number; impression_count?: number };
      const { data } = await http<{ data?: { id: string; public_metrics: M }[] }>('X', `https://api.x.com/2/tweets?ids=${ids.slice(i, i + 100).join(',')}&tweet.fields=public_metrics`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      for (const p of data.data ?? []) {
        const m = p.public_metrics;
        out[p.id] = { likes: m.like_count, comments: m.reply_count, shares: m.retweet_count + m.quote_count, views: m.impression_count ?? null };
      }
    }
    return out;
  },
  async followers(ch) {
    const t = await token(ch);
    const { data } = await http<{ data: { public_metrics?: { followers_count: number } } }>('X', 'https://api.x.com/2/users/me?user.fields=public_metrics', { headers: { Authorization: `Bearer ${t}` } });
    return data.data.public_metrics?.followers_count ?? null;
  },
};
