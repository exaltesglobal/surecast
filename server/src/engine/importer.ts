// Bulk scheduling from a spreadsheet. Every row is checked first (dates, channels, each
// network's limits), so the preview shows exactly what will happen before anything is saved.
import { HttpError, type AuthUser } from '../auth.js';
import { all } from '../db.js';
import { adapters } from '../platforms/index.js';
import { zonedToUtc } from '../util.js';
import { MAX_UPLOAD, storeMedia } from './content.js';
import { fetchPublic } from './fetch.js';
import { getClient, savePost, validateDraft } from './posts.js';

const MAX_ROWS = 500;

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. The
 * delimiter is whichever of comma, semicolon (Excel in many regions) or tab (pasted from a
 * sheet) appears most in the header line.
 */
export function parseCsv(input: string): string[][] {
  const s = input.replace(/^\uFEFF/, '');
  const header = s.split(/\r?\n/, 1)[0];
  const delimiter = [',', ';', '\t'].map((d) => [d, header.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const COLUMNS: Record<string, string[]> = {
  date: ['date', 'day'],
  time: ['time', 'hour'],
  text: ['text', 'body', 'message', 'post', 'caption', 'content'],
  channels: ['channels', 'channel', 'networks', 'network', 'platforms', 'platform'],
  images: ['image', 'images', 'image_url', 'image url', 'images_urls', 'media', 'media_url'],
  firstComment: ['first_comment', 'first comment', 'comment'],
};

const ALIASES: Record<string, string> = { twitter: 'x', 'x (twitter)': 'x', fb: 'facebook', ig: 'instagram', insta: 'instagram', tg: 'telegram' };

export type ImportRow = { row: number; text: string; scheduledAt: string | null; channelIds: string[]; channelNames: string[]; images: string[]; firstComment: string; issues: string[]; when: 'scheduled' | 'queue' | 'draft' };

function parseDate(date: string, time: string, tz: string): Date | null {
  const d = date.trim();
  let y: number, m: number, day: number;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(d);
  if (match) [y, m, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(d))) [day, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else return null;
  const t = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(time.trim() || '09:00');
  if (!t) return null;
  let h = Number(t[1]);
  if (t[3]) h = (h % 12) + (t[3].toLowerCase() === 'pm' ? 12 : 0);
  if (m < 1 || m > 12 || day < 1 || day > 31 || h > 23 || Number(t[2]) > 59) return null;
  return zonedToUtc(y, m, day, h, Number(t[2]), tz);
}

/** Checks every row without saving anything. */
export async function previewImport(workspaceId: string, clientId: unknown, csv: unknown) {
  const client = await getClient(workspaceId, clientId);
  if (typeof csv !== 'string' || !csv.trim()) throw new HttpError(422, 'Paste or upload a CSV file.');
  const [header, ...rows] = parseCsv(csv);
  if (!rows.length) throw new HttpError(422, 'The file has a header row but no posts.');
  if (rows.length > MAX_ROWS) throw new HttpError(422, `Import up to ${MAX_ROWS} posts at a time. This file has ${rows.length}.`);
  const col = (name: string) => header.findIndex((h) => COLUMNS[name].includes(h.trim().toLowerCase()));
  const idx = Object.fromEntries(Object.keys(COLUMNS).map((k) => [k, col(k)]));
  if (idx.text < 0) throw new HttpError(422, 'The file needs a "text" column with the post text. Download the template to see the format.');
  const channels = await all<{ id: string; platform: string; name: string; handle: string; status: string }>('SELECT id, platform, name, handle, status FROM channels WHERE client_id = ?', [client.id]);
  if (!channels.length) throw new HttpError(422, `${client.name} has no channels yet. Connect one first.`);
  const platforms = new Set(adapters().map((a) => a.platform as string));
  const hasQueue = JSON.parse(client.queue_slots || '[]').length > 0;
  const now = Date.now();

  const out: ImportRow[] = [];
  for (const [i, r] of rows.entries()) {
    const get = (k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    const issues: string[] = [];
    const text = idx.text >= 0 ? (r[idx.text] ?? '').trim() : '';
    let picked = channels.filter((c) => c.status !== 'disconnected');
    const wanted = get('channels');
    if (wanted && wanted.toLowerCase() !== 'all') {
      picked = [];
      for (const raw of wanted.split(/[|,;/]+/).map((x) => x.trim()).filter(Boolean)) {
        const w = ALIASES[raw.toLowerCase()] ?? raw.toLowerCase();
        const hits = platforms.has(w) ? channels.filter((c) => c.platform === w) : channels.filter((c) => c.name.toLowerCase() === w || c.handle.toLowerCase().replace(/^@/, '') === w.replace(/^@/, ''));
        if (!hits.length) issues.push(`No channel called "${raw}".`);
        picked.push(...hits.filter((h) => !picked.includes(h)));
      }
    }
    if (!picked.length && !issues.length) issues.push('No channels to post to.');
    let scheduledAt: Date | null = null;
    let when: ImportRow['when'] = hasQueue ? 'queue' : 'draft';
    if (get('date')) {
      scheduledAt = parseDate(get('date'), get('time'), client.timezone);
      if (!scheduledAt) issues.push(`"${get('date')} ${get('time')}" is not a date and time we understand. Use 2026-11-05 and 14:30.`);
      else {
        when = 'scheduled';
        if (scheduledAt.getTime() < now) issues.push('That time has already passed.');
      }
    }
    const images = get('images').split(/[\s|]+/).filter(Boolean).slice(0, 10);
    for (const u of images) if (!/^https?:\/\//i.test(u)) issues.push(`"${u.slice(0, 60)}" is not an image link.`);
    const firstComment = get('firstComment');
    if (!text && !images.length) issues.push('The post has no text or images.');
    if (!issues.length) {
      // Image sizes and types are checked when they are downloaded; the text is checked now.
      const report = await validateDraft(workspaceId, { body: text, channelIds: picked.map((c) => c.id), firstComment });
      for (const c of report) for (const issue of c.issues) if (!/needs? at least one image|empty/.test(issue) || !images.length) issues.push(`${channels.find((x) => x.id === c.channelId)?.name}: ${issue}`);
    }
    out.push({ row: i + 2, text, scheduledAt: scheduledAt?.toISOString() ?? null, channelIds: picked.map((c) => c.id), channelNames: picked.map((c) => c.name), images, firstComment, issues, when });
  }
  return { rows: out, ok: out.filter((r) => !r.issues.length).length, hasQueue };
}

/** Saves every valid row. Rows with problems are skipped and reported. */
export async function runImport(workspaceId: string, user: AuthUser | null, clientId: unknown, csv: unknown) {
  const preview = await previewImport(workspaceId, clientId, csv);
  const results: { row: number; ok: boolean; postId?: string; error?: string }[] = [];
  for (const r of preview.rows) {
    if (r.issues.length) {
      results.push({ row: r.row, ok: false, error: r.issues.join(' ') });
      continue;
    }
    try {
      const mediaIds: string[] = [];
      for (const url of r.images) {
        const file = await fetchPublic(url, { maxBytes: MAX_UPLOAD, accept: 'image/*' });
        mediaIds.push((await storeMedia(workspaceId, file.body, decodeURIComponent(new URL(file.url).pathname.split('/').pop() || 'image'))).id);
      }
      const postId = await savePost(
        workspaceId,
        user,
        { clientId, body: r.text, mediaIds, channelIds: r.channelIds, firstComment: r.firstComment, scheduledAt: r.scheduledAt, action: r.when === 'scheduled' ? 'schedule' : r.when },
        undefined,
        'csv',
      );
      results.push({ row: r.row, ok: true, postId });
    } catch (e) {
      const details = (e as { details?: { issues: string[] }[] }).details;
      results.push({ row: r.row, ok: false, error: details ? details.flatMap((d) => d.issues).join(' ') : (e as Error).message });
    }
  }
  return { results, created: results.filter((r) => r.ok).length };
}
