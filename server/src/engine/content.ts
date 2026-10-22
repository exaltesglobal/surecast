// Checks a post against a platform's limits. Used by the composer as you type, by the
// pre-flight check before the slot, and right before publishing.
import { config } from '../config.js';
import { all } from '../db.js';
import type { Adapter, MediaFile } from '../platforms/index.js';

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
