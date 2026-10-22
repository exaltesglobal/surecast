// Google Business Profile: "updates" on a business's Google Search and Maps listing. Each
// location is its own channel. Needs a Google Cloud project with the Business Profile APIs,
// which Google enables on request. The first link in the text becomes a "Learn more" button.
import { config } from '../config.js';
import { http } from './http.js';
import { codepoints, URL_RE } from './text.js';
import { PublishError, type Adapter, type ChannelCtx, type RemoteReview } from './types.js';

type Creds = { accessToken: string; refreshToken: string; account: string; location: string };

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

type Review = {
  name: string;
  reviewId: string;
  reviewer?: { displayName?: string; profilePhotoUrl?: string; isAnonymous?: boolean };
  starRating?: string;
  comment?: string;
  createTime: string;
  updateTime?: string;
  reviewReply?: { comment: string; updateTime: string };
};

/** Google sends a translation along with the original; keep only what the reviewer wrote. */
export function reviewText(comment: string | undefined) {
  if (!comment) return '';
  const original = comment.match(/\(Original\)\s*([\s\S]*)$/);
  return (original ? original[1] : comment.replace(/\s*\(Translated by Google\)[\s\S]*$/, '')).trim();
}

async function token(ch: ChannelCtx) {
  const c = ch.credentials as Creds;
  if (ch.tokenExpiresAt && ch.tokenExpiresAt.getTime() > Date.now() + 5 * 60_000) return c.accessToken;
  try {
    const { data } = await http<{ access_token: string; expires_in: number }>('Google', 'https://oauth2.googleapis.com/token', {
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

export const google: Adapter = {
  platform: 'google',
  label: 'Google Business',
  limits: { maxChars: 1500, maxImages: 1, maxImageBytes: 5_000_000, imageTypes: ['image/jpeg', 'image/png'] },
  available: () => !!config.google,
  unavailableReason: 'Google Business Profile needs a Google Cloud project with Business Profile API access. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to switch it on.',
  count: codepoints,
  connect: {
    kind: 'oauth',
    help: 'You will be sent to Google to approve Surecast, then pick the business locations to post to.',
    async start({ state, redirectUri }) {
      const q = new URLSearchParams({
        client_id: config.google!.id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/business.manage',
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      return { url: `https://accounts.google.com/o/oauth2/v2/auth?${q}` };
    },
    async finish({ code, redirectUri }) {
      const tok = await http<{ access_token: string; refresh_token?: string; expires_in: number }>('Google', 'https://oauth2.googleapis.com/token', {
        form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.google!.id, client_secret: config.google!.secret },
      });
      if (!tok.data.refresh_token) throw new PublishError('permanent', 'no_refresh', 'Google did not grant offline access', 'Remove Surecast from your Google account permissions, then connect again.');
      const auth = { Authorization: `Bearer ${tok.data.access_token}` };
      const accounts = await http<{ accounts?: { name: string; accountName: string }[] }>('Google', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts', { headers: auth });
      const out = [];
      for (const acct of accounts.data.accounts ?? []) {
        const locs = await http<{ locations?: { name: string; title: string; storefrontAddress?: { locality?: string } }[] }>(
          'Google',
          `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=name,title,storefrontAddress&pageSize=100`,
          { headers: auth },
        );
        for (const l of locs.data.locations ?? [])
          out.push({
            platform: 'google' as const,
            name: l.title,
            handle: l.storefrontAddress?.locality ?? acct.accountName,
            externalId: l.name,
            avatarUrl: null,
            credentials: { accessToken: tok.data.access_token, refreshToken: tok.data.refresh_token, account: acct.name, location: l.name } satisfies Creds,
            tokenExpiresAt: new Date(Date.now() + tok.data.expires_in * 1000),
            detail: `${acct.accountName}${l.storefrontAddress?.locality ? ` · ${l.storefrontAddress.locality}` : ''}`,
          });
      }
      if (!out.length) throw new PublishError('permanent', 'no_locations', 'No business locations were found on this Google account', 'Sign in with the Google account that manages the Business Profile.');
      return out;
    },
  },
  async check(ch) {
    const t = await token(ch);
    const c = ch.credentials as Creds;
    const { data } = await http<{ title: string }>('Google', `https://mybusinessbusinessinformation.googleapis.com/v1/${c.location}?readMask=title`, { headers: { Authorization: `Bearer ${t}` } });
    // The access token lasts an hour and refreshes itself, so there is no expiry to warn about.
    return { name: data.title, tokenExpiresAt: null };
  },
  async publish(ch, input) {
    const t = await token(ch);
    const c = ch.credentials as Creds;
    const link = input.text.match(URL_RE)?.[0];
    const body: Record<string, unknown> = { languageCode: 'en', topicType: 'STANDARD', summary: input.text };
    if (link) body.callToAction = { actionType: 'LEARN_MORE', url: link };
    if (input.media.length) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: input.media[0].url }];
    const { data } = await http<{ name: string; searchUrl?: string }>('Google', `https://mybusiness.googleapis.com/v4/${c.account}/${c.location}/localPosts`, {
      headers: { Authorization: `Bearer ${t}` },
      json: body,
    });
    return { remoteId: data.name, url: data.searchUrl ?? null };
  },
  // Updates on Google cannot be commented on; the inbox gets the location's reviews instead.
  async reviews(ch) {
    const t = await token(ch);
    const c = ch.credentials as Creds;
    const { data } = await http<{ reviews?: Review[] }>('Google', `https://mybusiness.googleapis.com/v4/${c.account}/${c.location}/reviews?pageSize=50&orderBy=updateTime%20desc`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    return (data.reviews ?? []).map(
      (r): RemoteReview => ({
        id: r.name,
        parentId: r.name,
        authorName: r.reviewer?.isAnonymous ? 'A Google user' : (r.reviewer?.displayName ?? 'A Google user'),
        authorHandle: '',
        authorAvatar: r.reviewer?.profilePhotoUrl ?? null,
        text: reviewText(r.comment),
        createdAt: new Date(r.createTime),
        url: null,
        rating: STARS[r.starRating ?? ''] ?? null,
        reply: r.reviewReply ? { text: r.reviewReply.comment, at: new Date(r.reviewReply.updateTime) } : null,
      }),
    );
  },
  async answer(ch, review, text) {
    const t = await token(ch);
    await http('Google', `https://mybusiness.googleapis.com/v4/${review.id}/reply`, { method: 'PUT', headers: { Authorization: `Bearer ${t}` }, json: { comment: text } });
    return { remoteId: `${review.id}/reply`, url: null };
  },
};
