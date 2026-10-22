// LinkedIn member profiles. Needs a LinkedIn developer app with the "Share on LinkedIn"
// and "Sign In with LinkedIn using OpenID Connect" products. Company pages need the
// Community Management API, which LinkedIn approves separately.
// Access tokens last 60 days and cannot be refreshed without partner approval, so
// Surecast warns a week before they expire.
import { config } from '../config.js';
import { http } from './http.js';
import { codepoints } from './text.js';
import { PublishError, type Adapter, type PostMetrics, type RemoteComment } from './types.js';

type Creds = { accessToken: string; personUrn: string };

const VERSION = process.env.LINKEDIN_VERSION || '202609';
const rest = (token: string) => ({ Authorization: `Bearer ${token}`, 'LinkedIn-Version': VERSION, 'X-Restli-Protocol-Version': '2.0.0' });

/** LinkedIn's "little text" format treats these characters as markup unless escaped. */
const escapeCommentary = (s: string) => s.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);

export const linkedin: Adapter = {
  platform: 'linkedin',
  label: 'LinkedIn',
  limits: { maxChars: 3000, maxImages: 9, maxImageBytes: 8_000_000, imageTypes: ['image/jpeg', 'image/png', 'image/gif'] },
  available: () => !!config.linkedin,
  unavailableReason: 'LinkedIn needs a developer app. Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to switch it on.',
  count: codepoints,
  connect: {
    kind: 'oauth',
    help: 'You will be sent to LinkedIn to approve Surecast.',
    async start({ state, redirectUri }) {
      const q = new URLSearchParams({ response_type: 'code', client_id: config.linkedin!.id, redirect_uri: redirectUri, state, scope: 'openid profile w_member_social' });
      return { url: `https://www.linkedin.com/oauth/v2/authorization?${q}` };
    },
    async finish({ code, redirectUri }) {
      const tok = await http<{ access_token: string; expires_in: number }>('LinkedIn', 'https://www.linkedin.com/oauth/v2/accessToken', {
        form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.linkedin!.id, client_secret: config.linkedin!.secret },
      });
      const me = await http<{ sub: string; name: string; picture?: string }>('LinkedIn', 'https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${tok.data.access_token}` } });
      return [
        {
          platform: 'linkedin',
          name: me.data.name,
          handle: me.data.name,
          externalId: me.data.sub,
          avatarUrl: me.data.picture ?? null,
          credentials: { accessToken: tok.data.access_token, personUrn: `urn:li:person:${me.data.sub}` } satisfies Creds,
          tokenExpiresAt: new Date(Date.now() + tok.data.expires_in * 1000),
        },
      ];
    },
  },
  async check(ch) {
    const c = ch.credentials as Creds;
    if (ch.tokenExpiresAt && ch.tokenExpiresAt.getTime() < Date.now())
      throw new PublishError('auth', 'token_expired', 'The LinkedIn token has expired', 'LinkedIn connections last 60 days. Reconnect this channel.');
    const { data } = await http<{ name: string; picture?: string }>('LinkedIn', 'https://api.linkedin.com/v2/userinfo', { headers: { Authorization: `Bearer ${c.accessToken}` } });
    return { name: data.name, avatarUrl: data.picture ?? null };
  },
  async publish(ch, input) {
    const c = ch.credentials as Creds;
    const images: { id: string; altText: string }[] = [];
    for (const m of input.media) {
      const init = await http<{ value: { uploadUrl: string; image: string } }>('LinkedIn', 'https://api.linkedin.com/rest/images?action=initializeUpload', {
        headers: rest(c.accessToken),
        json: { initializeUploadRequest: { owner: c.personUrn } },
      });
      await http('LinkedIn', init.data.value.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': m.mime }, body: new Uint8Array(await m.data()), timeoutMs: 90_000 });
      images.push({ id: init.data.value.image, altText: m.alt.slice(0, 4000) });
    }
    const body: Record<string, unknown> = {
      author: c.personUrn,
      commentary: escapeCommentary(input.text),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    };
    if (images.length === 1) body.content = { media: images[0] };
    else if (images.length > 1) body.content = { multiImage: { images } };
    const res = await http('LinkedIn', 'https://api.linkedin.com/rest/posts', { headers: rest(c.accessToken), json: body });
    const urn = res.headers.get('x-restli-id') ?? '';
    return { remoteId: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
  },
  followUps: 'comment',
  async reply(ch, target, text) {
    const c = ch.credentials as Creds;
    const { data } = await http<{ id?: string; commentUrn?: string }>('LinkedIn', `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(target.rootId)}/comments`, {
      headers: rest(c.accessToken),
      json: { actor: c.personUrn, object: target.rootId, message: { text } },
    });
    return { remoteId: data.commentUrn ?? data.id ?? '', url: `https://www.linkedin.com/feed/update/${target.rootId}/` };
  },
  async metrics(ch, urns) {
    // Reading reactions needs LinkedIn's Community Management API. Without it LinkedIn answers 403,
    // and the posts simply show no numbers.
    const c = ch.credentials as Creds;
    const out: Record<string, PostMetrics> = {};
    for (const urn of urns) {
      try {
        const { data } = await http<{ likesSummary?: { totalLikes?: number }; commentsSummary?: { aggregatedTotalComments?: number } }>(
          'LinkedIn',
          `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(urn)}`,
          { headers: rest(c.accessToken) },
        );
        out[urn] = { likes: data.likesSummary?.totalLikes ?? 0, comments: data.commentsSummary?.aggregatedTotalComments ?? 0, shares: 0, views: null };
      } catch (e) {
        if (e instanceof PublishError && (e.httpStatus === 403 || e.httpStatus === 404)) continue;
        throw e;
      }
    }
    return out;
  },
  async comments(ch, urns) {
    // Like reactions, reading comments needs LinkedIn's Community Management API.
    const c = ch.credentials as Creds;
    const out: Record<string, RemoteComment[]> = {};
    type C = { id?: string; commentUrn?: string; actor: string; message?: { text: string }; created?: { time: number }; parentComment?: string };
    for (const urn of urns) {
      try {
        const { data } = await http<{ elements: C[] }>('LinkedIn', `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(urn)}/comments`, { headers: rest(c.accessToken) });
        out[urn] = data.elements
          .filter((x) => x.actor !== c.personUrn)
          .map((x) => ({
            id: x.commentUrn ?? x.id ?? '',
            parentId: x.parentComment ?? urn,
            authorName: 'LinkedIn member',
            authorHandle: '',
            authorAvatar: null,
            text: x.message?.text ?? '',
            createdAt: new Date(x.created?.time ?? Date.now()),
            url: `https://www.linkedin.com/feed/update/${urn}/`,
          }));
      } catch (e) {
        if (e instanceof PublishError && (e.httpStatus === 403 || e.httpStatus === 404)) return out;
        throw e;
      }
    }
    return out;
  },
  async answer(ch, comment, text) {
    const c = ch.credentials as Creds;
    const { data } = await http<{ id?: string; commentUrn?: string }>('LinkedIn', `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(comment.rootId)}/comments`, {
      headers: rest(c.accessToken),
      json: { actor: c.personUrn, object: comment.rootId, parentComment: comment.id, message: { text } },
    });
    return { remoteId: data.commentUrn ?? data.id ?? '', url: `https://www.linkedin.com/feed/update/${comment.rootId}/` };
  },
};
