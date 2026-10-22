// Checks a post against a platform's limits. Used by the composer as you type, by the
// pre-flight check before the slot, and right before publishing.
import { config } from '../config.js';
import { HttpError } from '../auth.js';
import { all, run } from '../db.js';
import type { Adapter, MediaFile } from '../platforms/index.js';
import { newId, token } from '../util.js';

export type MediaMeta = { id: string; mime: string; size: number; filename: string; alt: string; public_key: string };

export function contentIssues(a: Adapter, text: string, media: Pick<MediaMeta, 'mime' | 'size' | 'filename'>[]): string[] {
  const issues: string[] = [];
  const n = a.count(text);
  const max = a.platform === 'telegram' && media.length ? 1024 : a.limits.maxChars;
  if (n > max) issues.push(`${a.label} allows ${max} characters${a.platform === 'telegram' && media.length ? ' with images' : ''}; this is ${n}.`);
  if (!text.trim() && !media.length) issues.push('The post is empty.');
  if (a.limits.requiresMedia && !media.length) issues.push(`${a.label} posts need at least one image.`);
  if (media.length > a.limits.maxImages) issues.push(`${a.label} allows up to ${a.limits.maxImages} images; this has ${media.length}.`);
  for (const m of media) {
    if (!a.limits.imageTypes.includes(m.mime)) issues.push(`${a.label} cannot use ${m.filename} (${m.mime.replace('image/', '').toUpperCase()}). Use ${a.limits.imageTypes.map((t) => t.replace('image/', '').toUpperCase()).join(', ')}.`);
    if (m.size > a.limits.maxImageBytes) issues.push(`${m.filename} is ${(m.size / 1e6).toFixed(1)} MB; ${a.label} allows ${(a.limits.maxImageBytes / 1e6).toFixed(1)} MB.`);
  }
  return issues;
}

export async function mediaMeta(ids: string[]): Promise<MediaMeta[]> {
  if (!ids.length) return [];
  const rows = await all<MediaMeta>('SELECT id, mime, size, filename, COALESCE(alt, \'\') AS alt, public_key FROM media WHERE id IN (?)', [ids]);
  return ids.map((id) => rows.find((r) => r.id === id)).filter((r): r is MediaMeta => !!r);
}

export const mediaUrl = (publicKey: string) => `${config.publicUrl}/m/${publicKey}`;

export function mediaFiles(meta: MediaMeta[]): MediaFile[] {
  return meta.map((m) => ({
    id: m.id,
    mime: m.mime,
    filename: m.filename,
    size: m.size,
    alt: m.alt,
    url: mediaUrl(m.public_key),
    data: async () => {
      const row = (await all<{ data: Buffer }>('SELECT data FROM media WHERE id = ?', [m.id]))[0];
      if (!row) throw new Error(`Image ${m.filename} was deleted`);
      return row.data;
    },
  }));
}

/** Detects the real image type from its first bytes rather than trusting the upload. */
export function sniffImage(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export const MAX_UPLOAD = 10_000_000;

/** Saves an image to the media library. Images live in the database so they survive redeploys. */
export async function storeMedia(workspaceId: string, buf: Buffer, name: string, alt = '') {
  if (buf.length > MAX_UPLOAD) throw new HttpError(413, 'Images can be up to 10 MB.');
  const mime = sniffImage(buf);
  if (!mime) throw new HttpError(422, 'Use a JPEG, PNG, GIF or WebP image.');
  const id = newId('med');
  const key = token(18);
  const filename = (name || 'image').replace(/[^\w.\- ]+/g, '').slice(0, 190) || 'image';
  await run('INSERT INTO media (id, workspace_id, public_key, filename, mime, size, alt, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, workspaceId, key, filename, mime, buf.length, alt || null, buf, new Date()]);
  return { id, filename, mime, key };
}
