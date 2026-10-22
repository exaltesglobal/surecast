// TikTok, through the Content Posting API (Direct Post) with Login Kit OAuth. A post is one
// video uploaded from Surecast; the text is the caption. Until TikTok audits the app, posts
// can only be private ("only me"), so Surecast picks the most public option TikTok allows.
import { config } from '../config.js';
import { http } from './http.js';
import { codepoints } from './text.js';
import { PublishError, type Adapter, type ChannelCtx, type PostMetrics } from './types.js';

type Creds = { accessToken: string; refreshToken: string; openId: string; username: string };

const API = 'https://open.tiktokapis.com/v2';
const SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.publish', 'video.list'];

/** TikTok answers 200 with error.code set for some failures, and uses its own codes for the rest. */
async function tt<T>(url: string, opts: Parameters<typeof http>[2] = {}): Promise<T> {
  let res;
  try {
    res = await http<{ data: T; error?: { code: string; message: string } }>('TikTok', url, opts);
  } catch (e) {
    if (e instanceof PublishError) refine(e, e.body?.error?.code, e.body?.error?.message);
    throw e;
  }
  const err = res.data.error;
  if (err && err.code !== 'ok') {
    const e = new PublishError('permanent', 'rejected', `TikTok returned ${err.code}: ${err.message}`, 'TikTok rejected the post. Edit it and try again.');
    refine(e, err.code, err.message);
    throw e;
  }
  return res.data.data;
}

function refine(e: PublishError, code?: string, message?: string) {
  if (!code) return;
  if (code === 'access_token_invalid' || code === 'scope_not_authorized') {
    e.kind = 'auth';
    e.hint = 'TikTok no longer accepts this connection. Reconnect this channel.';
  } else if (code === 'rate_limit_exceeded' || code === 'spam_risk_too_many_posts' || code === 'spam_risk_too_many_pending_share') {
    e.kind = 'temporary';
    e.code = 'rate_limited';
    e.hint = 'TikTok limits how many posts an account can make in a day. Surecast will try again in an hour.';
    e.retryAfter = new Date(Date.now() + 3_600_000);
  } else if (code === 'unaudited_client_can_only_post_to_private_accounts') {
    e.hint = 'TikTok has not audited the Surecast app yet, so it can only post to private accounts. Make the TikTok account private, or finish the audit.';
  } else if (code === 'spam_risk_user_banned_from_posting' || code === 'reached_active_user_cap') {
    e.hint = message ?? 'TikTok is not letting this account post right now.';
  }
}

async function token(ch: ChannelCtx) {
  const c = ch.credentials as Creds;
  if (ch.tokenExpiresAt && ch.tokenExpiresAt.getTime() > Date.now() + 10 * 60_000) return c.accessToken;
  try {
    const { data } = await http<{ access_token: string; refresh_token: string; expires_in: number }>('TikTok', `${API}/oauth/token/`, {
      form: { client_key: config.tiktok!.id, client_secret: config.tiktok!.secret, grant_type: 'refresh_token', refresh_token: c.refreshToken },
    });
    if (!data.access_token) throw new PublishError('auth', 'refresh_failed', 'TikTok did not refresh the connection', 'Reconnect this channel.');
    await ch.saveCredentials({ ...c, accessToken: data.access_token, refreshToken: data.refresh_token ?? c.refreshToken }, new Date(Date.now() + data.expires_in * 1000));
    return data.access_token;
  } catch (e) {
    if (e instanceof PublishError && (e.httpStatus === 400 || e.httpStatus === 401)) {
      e.kind = 'auth';
      e.hint = 'TikTok no longer accepts this connection (it was revoked or unused for a year). Reconnect this channel.';
    }
    throw e;
  }
}

type User = { open_id: string; display_name: string; username?: string; avatar_url?: string; follower_count?: number };

/** Upload chunks must be 5 to 64 MB, with the last one absorbing the remainder. One chunk below 64 MB. */
export function chunkPlan(size: number) {
  if (size <= 64_000_000) return { chunkSize: size, count: 1 };
  const chunkSize = 10_000_000;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const tiktok: Adapter = {
  platform: 'tiktok',
  label: 'TikTok',
  limits: {
    maxChars: 2200,
    maxImages: 0,
    maxImageBytes: 0,
    imageTypes: [],
    videoTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    maxVideoBytes: 100_000_000,
    requiresVideo: true,
  },
  available: () => !!config.tiktok,
  unavailableReason: 'TikTok needs a developer app with the Content Posting API. Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to switch it on.',
  count: codepoints,
  connect: {
    kind: 'oauth',
    help: 'You will be sent to TikTok to approve Surecast. Posts are videos; the text becomes the caption.',
    async start({ state, redirectUri }) {
      const q = new URLSearchParams({ client_key: config.tiktok!.id, scope: SCOPES.join(','), response_type: 'code', redirect_uri: redirectUri, state });
      return { url: `https://www.tiktok.com/v2/auth/authorize/?${q}` };
    },
    async finish({ code, redirectUri }) {
      const { data: tok } = await http<{ access_token?: string; refresh_token: string; expires_in: number; open_id: string; error?: string; error_description?: string }>('TikTok', `${API}/oauth/token/`, {
        form: { client_key: config.tiktok!.id, client_secret: config.tiktok!.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri },
      });
      if (!tok.access_token) throw new PublishError('permanent', 'oauth_failed', `TikTok did not connect: ${tok.error_description ?? tok.error ?? 'no token'}`, 'Try connecting again.');
      const { user } = await tt<{ user: User }>(`${API}/user/info/?fields=open_id,display_name,username,avatar_url`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      return [
        {
          platform: 'tiktok' as const,
          name: user.display_name,
          handle: user.username ? `@${user.username}` : user.display_name,
          externalId: user.open_id,
          avatarUrl: user.avatar_url ?? null,
          credentials: { accessToken: tok.access_token, refreshToken: tok.refresh_token, openId: user.open_id, username: user.username ?? '' } satisfies Creds,
          tokenExpiresAt: new Date(Date.now() + tok.expires_in * 1000),
          detail: 'TikTok account',
        },
      ];
    },
  },
  async check(ch) {
    const t = await token(ch);
    const { user } = await tt<{ user: User }>(`${API}/user/info/?fields=open_id,display_name,avatar_url`, { headers: { Authorization: `Bearer ${t}` } });
    // The access token lasts a day and the refresh token a year; both refresh themselves.
    return { name: user.display_name, avatarUrl: user.avatar_url ?? null, tokenExpiresAt: null };
  },
  async publish(ch, input) {
    const video = input.media.find((m) => m.mime.startsWith('video/'));
    if (!video) throw new PublishError('permanent', 'no_video', 'TikTok posts need a video', 'Add a video to this post.');
    const t = await token(ch);
    const auth = { Authorization: `Bearer ${t}` };
    // TikTok requires asking what this creator may post before every post.
    const creator = await tt<{ privacy_level_options: string[]; comment_disabled?: boolean; duet_disabled?: boolean; stitch_disabled?: boolean }>(`${API}/post/publish/creator_info/query/`, {
      headers: auth,
      json: {},
    });
    const options = creator.privacy_level_options ?? [];
    const privacy = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'].find((p) => options.includes(p)) ?? 'SELF_ONLY';
    const bytes = await video.data();
    const plan = chunkPlan(bytes.length);
    const init = await tt<{ publish_id: string; upload_url: string }>(`${API}/post/publish/video/init/`, {
      headers: auth,
      json: {
        post_info: {
          title: input.text.slice(0, 2200),
          privacy_level: privacy,
          disable_comment: !!creator.comment_disabled,
          disable_duet: !!creator.duet_disabled,
          disable_stitch: !!creator.stitch_disabled,
        },
        source_info: { source: 'FILE_UPLOAD', video_size: bytes.length, chunk_size: plan.chunkSize, total_chunk_count: plan.count },
      },
    });
    for (let i = 0; i < plan.count; i++) {
      const start = i * plan.chunkSize;
      const end = i === plan.count - 1 ? bytes.length : start + plan.chunkSize;
      await http('TikTok', init.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': video.mime, 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` },
        body: new Blob([new Uint8Array(bytes.subarray(start, end))], { type: video.mime }),
        timeoutMs: 3 * 60_000,
      });
    }
    // TikTok processes the video after upload. Wait up to a minute for the post id.
    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      const s = await tt<{ status: string; fail_reason?: string; publicaly_available_post_id?: (string | number)[] }>(`${API}/post/publish/status/fetch/`, {
        headers: auth,
        json: { publish_id: init.publish_id },
      });
      if (s.status === 'FAILED') throw new PublishError('permanent', 'media_rejected', `TikTok could not publish the video: ${s.fail_reason ?? 'unknown reason'}`, 'Check the video meets TikTok rules (3 seconds to 10 minutes, at least 360p) and try again.');
      if (s.status === 'PUBLISH_COMPLETE') {
        const id = s.publicaly_available_post_id?.[0];
        const user = (ch.credentials as Creds).username;
        return { remoteId: id ? String(id) : init.publish_id, url: id && user ? `https://www.tiktok.com/@${user}/video/${id}` : null };
      }
    }
    // Still processing: TikTok will finish on its own; the post is accepted.
    return { remoteId: init.publish_id, url: null };
  },
  async metrics(ch, ids) {
    const t = await token(ch);
    const out: Record<string, PostMetrics> = {};
    const numeric = ids.filter((id) => /^\d+$/.test(id));
    for (let i = 0; i < numeric.length; i += 20) {
      const { videos } = await tt<{ videos: { id: string; like_count?: number; comment_count?: number; share_count?: number; view_count?: number }[] }>(
        `${API}/video/query/?fields=id,like_count,comment_count,share_count,view_count`,
        { headers: { Authorization: `Bearer ${t}` }, json: { filters: { video_ids: numeric.slice(i, i + 20) } } },
      );
      for (const v of videos ?? []) out[v.id] = { likes: v.like_count ?? 0, comments: v.comment_count ?? 0, shares: v.share_count ?? 0, views: v.view_count ?? null };
    }
    return out;
  },
  async followers(ch) {
    const t = await token(ch);
    const { user } = await tt<{ user: User }>(`${API}/user/info/?fields=follower_count`, { headers: { Authorization: `Bearer ${t}` } });
    return user.follower_count ?? null;
  },
};
