// Link tracking. When a client has it turned on, every link in a post is swapped for a short
// surecast link at publish time, one per network, so clicks can be counted per post and per
// network. UTM tags can be added to the destination as well (with or without short links).
import { createHash } from 'node:crypto';

import { config } from '../config.js';
import { one, run } from '../db.js';
import { URL_RE } from '../platforms/text.js';
import { randomString } from '../util.js';

export type LinkSettings = { track: boolean; utm: boolean; campaign: string };
export const DEFAULT_LINKS: LinkSettings = { track: false, utm: false, campaign: '' };

export function parseLinkSettings(raw: string | null | undefined): LinkSettings {
  try {
    const v = raw ? JSON.parse(raw) : {};
    return { track: !!v.track, utm: !!v.utm, campaign: typeof v.campaign === 'string' ? v.campaign.slice(0, 80) : '' };
  } catch {
    return DEFAULT_LINKS;
  }
}

export const shortBase = () => `${config.publicUrl}/l/`;

/** Adds utm_source (the network), utm_medium=social and utm_campaign, unless the link already has UTM tags. */
export function withUtm(url: string, platform: string, campaign: string) {
  try {
    const u = new URL(url);
    if ([...u.searchParams.keys()].some((k) => k.startsWith('utm_'))) return url;
    u.searchParams.set('utm_source', platform);
    u.searchParams.set('utm_medium', 'social');
    u.searchParams.set('utm_campaign', campaign || 'surecast');
    return u.toString();
  } catch {
    return url;
  }
}

/** The short code for a link in a given scope. The same scope and URL always get the same code. */
export async function shortCode(o: { workspaceId: string; clientId: string; scope: string; url: string; postId?: string | null; targetId?: string | null; platform?: string | null }) {
  const hash = createHash('sha256').update(o.url).digest('hex');
  const existing = await one<{ code: string }>('SELECT code FROM links WHERE scope = ? AND url_hash = ?', [o.scope, hash]);
  if (existing) return existing.code;
  for (let i = 0; i < 5; i++) {
    const code = randomString(7);
    try {
      await run('INSERT INTO links (code, workspace_id, client_id, post_id, target_id, scope, platform, url, url_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        code,
        o.workspaceId,
        o.clientId,
        o.postId ?? null,
        o.targetId ?? null,
        o.scope,
        o.platform ?? null,
        o.url.slice(0, 2000),
        hash,
        new Date(),
      ]);
      return code;
    } catch (e) {
      // Another worker made the same link first, or the random code was taken.
      const again = await one<{ code: string }>('SELECT code FROM links WHERE scope = ? AND url_hash = ?', [o.scope, hash]);
      if (again) return again.code;
      if ((e as { code?: string }).code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  throw new Error('Could not create a short link');
}

/** Rewrites the links in text for one post-to-channel, following the client's link settings. */
export async function prepareLinks(text: string, o: { workspaceId: string; clientId: string; postId: string; targetId: string; platform: string }) {
  const found = text?.match(URL_RE);
  if (!found) return text;
  const client = await one<{ link_settings: string | null }>('SELECT link_settings FROM clients WHERE id = ?', [o.clientId]);
  const s = parseLinkSettings(client?.link_settings);
  if (!s.track && !s.utm) return text;
  const base = shortBase();
  // Longest first, so a link that starts with another link is replaced whole.
  const urls = [...new Set(found)].filter((u) => !u.startsWith(base)).sort((a, b) => b.length - a.length);
  let out = text;
  for (const u of urls) {
    const dest = s.utm ? withUtm(u, o.platform, s.campaign) : u;
    const next = s.track ? base + (await shortCode({ ...o, scope: o.targetId, url: dest })) : dest;
    out = out.split(u).join(next);
  }
  return out;
}

const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|meta-externalagent|mastodon|pleroma|akkoma|misskey|cardyb|embedly|whatsapp|skype|slack|discord|telegram|curl|wget|python|go-http|axios|node-fetch|okhttp|headless/i;

/** Resolves a short link and counts the click. Link-preview fetchers from the networks are not counted. */
export async function openLink(code: string, ua: string, referrer: string | null) {
  const link = await one<{ code: string; url: string; client_id: string; target_id: string | null }>('SELECT code, url, client_id, target_id FROM links WHERE code = ?', [code]);
  if (!link) return null;
  if (ua && !BOTS.test(ua)) {
    let ref: string | null = null;
    try {
      ref = referrer ? new URL(referrer).host.slice(0, 255) : null;
    } catch {
      /* ignore odd referrers */
    }
    await run('UPDATE links SET clicks = clicks + 1 WHERE code = ?', [code]);
    await run('INSERT INTO link_clicks (code, client_id, clicked_at, referrer) VALUES (?, ?, ?, ?)', [code, link.client_id, new Date(), ref]);
    if (link.target_id) await run('UPDATE post_targets SET clicks = clicks + 1 WHERE id = ?', [link.target_id]);
  }
  return link.url;
}
