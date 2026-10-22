// RSS and Atom feeds: each new article becomes a post (queued, drafted or posted right away).
// The first check only remembers what is already in the feed, so connecting a blog never
// floods a client's channels with old articles.
import { XMLParser } from 'fast-xml-parser';

import { HttpError } from '../auth.js';
import { all, json, one, run, type Row } from '../db.js';
import { clip, minutes } from '../util.js';
import { raiseAlert, resolveAlerts } from './alerts.js';
import { fetchPublic } from './fetch.js';
import { savePost } from './posts.js';

export type FeedItem = { id: string; title: string; link: string; summary: string; published: Date | null };

const CHECK_EVERY = minutes(15);
const MAX_NEW_PER_CHECK = 5;
const SEEN_KEEP = 500;

const text = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text((v as Record<string, unknown>)['#text'] ?? '');
  return '';
};

/** Strips tags and entities so an article summary reads as plain text. */
export function plain(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

const list = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []);

export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', processEntities: true, htmlEntities: true }).parse(xml);
  const date = (v: unknown) => {
    const d = new Date(text(v));
    return Number.isNaN(d.getTime()) ? null : d;
  };
  if (doc.rss?.channel || doc['rdf:RDF']) {
    const ch = doc.rss?.channel ?? doc['rdf:RDF'].channel ?? {};
    const raw = list(doc.rss?.channel?.item ?? doc['rdf:RDF']?.item);
    return {
      title: plain(text(ch.title)),
      items: raw.map((i: Record<string, unknown>) => {
        const link = text(i.link);
        return {
          id: text(i.guid) || link || text(i.title),
          title: plain(text(i.title)),
          link,
          summary: plain(text(i.description ?? i['content:encoded'])),
          published: date(i.pubDate ?? i['dc:date']),
        };
      }),
    };
  }
  if (doc.feed) {
    return {
      title: plain(text(doc.feed.title)),
      items: list(doc.feed.entry).map((e: Record<string, any>) => {
        const links = list(e.link) as Record<string, string>[];
        const link = (links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') ?? links[0])?.['@href'] ?? '';
        return { id: text(e.id) || link, title: plain(text(e.title)), link, summary: plain(text(e.summary ?? e.content)), published: date(e.published ?? e.updated) };
      }),
    };
  }
  throw new HttpError(422, "That address doesn't look like an RSS or Atom feed.");
}

export async function loadFeed(url: string) {
  const res = await fetchPublic(url, { maxBytes: 5_000_000, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' });
  const feed = parseFeed(res.body.toString('utf8'));
  return { ...feed, items: feed.items.filter((i) => i.id && (i.title || i.link)) };
}

/** Fills {title}, {link} and {summary} in a feed's post template. */
export function renderTemplate(template: string, item: FeedItem) {
  return template
    .replace(/\{title\}/g, item.title)
    .replace(/\{link\}/g, item.link)
    .replace(/\{summary\}/g, clip(item.summary, 280) ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function checkFeeds(now: Date) {
  const due = await all<Row>('SELECT * FROM feeds WHERE active = 1 AND (last_checked_at IS NULL OR last_checked_at < ?) ORDER BY last_checked_at LIMIT 10', [new Date(now.getTime() - CHECK_EVERY)]);
  for (const f of due) await checkFeed(f, now);
}

export async function checkFeed(f: Row, now = new Date()) {
  // Claim it first so two ticks never post the same article.
  const claimed = await run('UPDATE feeds SET last_checked_at = ? WHERE id = ? AND (last_checked_at <=> ?)', [now, f.id, f.last_checked_at]);
  if (!claimed) return { created: 0 };
  let items: FeedItem[];
  try {
    const feed = await loadFeed(f.url);
    items = feed.items;
    if (feed.title && feed.title !== f.title) await run('UPDATE feeds SET title = ? WHERE id = ?', [clip(feed.title, 255), f.id]);
  } catch (e) {
    const failures = f.failures + 1;
    const message = (e as Error).message;
    await run('UPDATE feeds SET failures = ?, last_error = ? WHERE id = ?', [failures, clip(message, 1000), f.id]);
    if (failures >= 4)
      await raiseAlert({
        workspaceId: f.workspace_id,
        key: `feed:${f.id}:failing`,
        kind: 'feed_failing',
        severity: 'warning',
        title: `The feed "${f.title || f.url}" could not be read for an hour`,
        detail: `${message}. New articles will not be posted until it works again. Check the address in the client's Feeds section.`,
        clientId: f.client_id,
      });
    return { created: 0 };
  }
  await resolveAlerts(f.workspace_id, [`feed:${f.id}:failing`]);
  const firstCheck = f.seen == null;
  const seen = new Set(json<string[]>(f.seen, []));
  const fresh = firstCheck ? [] : items.filter((i) => !seen.has(i.id)).reverse().slice(-MAX_NEW_PER_CHECK);
  let created = 0;
  for (const item of fresh) {
    if (await postItem(f, item)) created++;
  }
  const allSeen = [...items.map((i) => i.id), ...seen].filter((v, i, a) => a.indexOf(v) === i).slice(0, SEEN_KEEP);
  await run('UPDATE feeds SET seen = ?, failures = 0, last_error = NULL, last_item_at = IF(?, ?, last_item_at) WHERE id = ?', [JSON.stringify(allSeen), created > 0, now, f.id]);
  return { created };
}

async function postItem(f: Row, item: FeedItem) {
  const channels = await all<{ id: string }>('SELECT id FROM channels WHERE id IN (?) AND client_id = ?', [json<string[]>(f.channel_ids, []).concat(''), f.client_id]);
  const input = { clientId: f.client_id, body: renderTemplate(f.template, item), channelIds: channels.map((c) => c.id), action: channels.length ? f.mode : 'draft' };
  try {
    await savePost(f.workspace_id, null, input, undefined, 'rss');
    return true;
  } catch (e) {
    // Keep the article as a draft rather than lose it, and say why.
    await savePost(f.workspace_id, null, { ...input, action: 'draft' }, undefined, 'rss').catch(() => undefined);
    await raiseAlert({
      workspaceId: f.workspace_id,
      key: `feed:${f.id}:item:${clip(item.id, 120)}`,
      kind: 'feed_item_draft',
      severity: 'warning',
      title: `A new article from "${f.title || f.url}" was saved as a draft`,
      detail: `${(e as Error).message} Open the drafts to fix it and schedule it.`,
      clientId: f.client_id,
    });
    return false;
  }
}

export function feedJson(f: Row) {
  return {
    id: f.id,
    clientId: f.client_id,
    url: f.url,
    title: f.title,
    channelIds: json<string[]>(f.channel_ids, []),
    template: f.template,
    mode: f.mode,
    active: !!f.active,
    lastCheckedAt: f.last_checked_at,
    lastItemAt: f.last_item_at,
    lastError: f.last_error,
  };
}

export async function getFeed(workspaceId: string, id: string) {
  const f = await one<Row>('SELECT * FROM feeds WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  if (!f) throw new HttpError(404, 'Feed not found.');
  return f;
}
