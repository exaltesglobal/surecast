// Checks a post against a platform's limits. Used by the composer as you type, by the
// pre-flight check before the slot, and right before publishing.
import { config } from '../config.js';
import { HttpError } from '../auth.js';
import { all, run } from '../db.js';
import { PublishError, type Adapter, type MediaFile } from '../platforms/index.js';
import { newId, token } from '../util.js';
import { downloadFromDrive, DriveError, getDrive, uploadToDrive } from './drive.js';

export type MediaMeta = { id: string; mime: string; size: number; filename: string; alt: string; public_key: string };

export function contentIssues(a: Adapter, text: string, media: Pick<MediaMeta, 'mime' | 'size' | 'filename'>[]): string[] {
  const issues: string[] = [];
  const n = a.count(text);
  const max = a.platform === 'telegram' && media.length ? 1024 : a.limits.maxChars;
  if (n > max) issues.push(`${a.label} allows ${max} characters${a.platform === 'telegram' && media.length ? ' with images' : ''}; this is ${n}.`);
  if (!text.trim() && !media.length) issues.push('The post is empty.');
  const videos = media.filter((m) => m.mime.startsWith('video/'));
  const images = media.filter((m) => !m.mime.startsWith('video/'));
  if (a.limits.requiresVideo && !videos.length) issues.push(`${a.label} posts need a video.`);
  else if (a.limits.requiresMedia && !media.length) issues.push(`${a.label} posts need at least one image.`);
  if (videos.length) {
    const types = a.limits.videoTypes ?? [];
    if (!types.length) issues.push(`${a.label} posts from Surecast can't include videos yet. Use images, or leave ${a.label} out of this post.`);
    else {
      if (videos.length > 1 || images.length) issues.push(`${a.label} takes one video per post, without images.`);
      for (const v of videos) {
        if (!types.includes(v.mime)) issues.push(`${a.label} cannot use ${v.filename}. Use ${types.map((t) => t.replace('video/', '').replace('quicktime', 'MOV').toUpperCase()).join(' or ')}.`);
        if (v.size > (a.limits.maxVideoBytes ?? 0)) issues.push(`${v.filename} is ${(v.size / 1e6).toFixed(0)} MB; ${a.label} allows ${((a.limits.maxVideoBytes ?? 0) / 1e6).toFixed(0)} MB.`);
      }
    }
  }
  if (images.length && a.limits.maxImages === 0) issues.push(`${a.label} posts can't include images; add a video instead.`);
  else {
    if (images.length > a.limits.maxImages) issues.push(`${a.label} allows up to ${a.limits.maxImages} images; this has ${images.length}.`);
    for (const m of images) {
      if (!a.limits.imageTypes.includes(m.mime)) issues.push(`${a.label} cannot use ${m.filename} (${m.mime.replace('image/', '').toUpperCase()}). Use ${a.limits.imageTypes.map((t) => t.replace('image/', '').toUpperCase()).join(', ')}.`);
      if (m.size > a.limits.maxImageBytes) issues.push(`${m.filename} is ${(m.size / 1e6).toFixed(1)} MB; ${a.label} allows ${(a.limits.maxImageBytes / 1e6).toFixed(1)} MB.`);
    }
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
    data: () => mediaData(m.id, m.filename).catch(driveFailure),
  }));
}

/** Turns a Google Drive problem into a publish error: a missing file or lost access will not fix itself by retrying. */
function driveFailure(e: unknown): never {
  if (!(e instanceof DriveError)) throw e;
  if (e.status === 0 || e.status === 429 || e.status >= 500) throw new PublishError('temporary', 'drive_unavailable', e.message, 'Surecast will retry automatically.');
  throw new PublishError('permanent', 'drive_media', e.message, 'Fix it in Google Drive or Settings, then retry the post.');
}

/** The bytes of an image or video, from Google Drive or joined from the chunks a video is stored in. */
export async function mediaData(id: string, filename = 'file'): Promise<Buffer> {
  const row = (await all<{ workspace_id: string; data: Buffer; chunks: number; drive_file_id: string | null }>('SELECT workspace_id, data, chunks, drive_file_id FROM media WHERE id = ?', [id]))[0];
  if (!row) throw new Error(`${filename} was deleted`);
  if (row.drive_file_id) return downloadFromDrive(row.workspace_id, row.drive_file_id, filename);
  if (!row.chunks) return row.data;
  const parts = await all<{ data: Buffer }>('SELECT data FROM media_chunks WHERE media_id = ? ORDER BY seq', [id]);
  if (parts.length !== row.chunks) throw new Error(`${filename} is incomplete; upload it again`);
  return Buffer.concat(parts.map((p) => p.data));
}

/** Keeps the bytes in the Surecast database: images in one row, videos in 4 MB chunks. */
export async function storeBytes(id: string, buf: Buffer) {
  const video = !!sniffVideo(buf);
  const chunks = video ? Math.ceil(buf.length / CHUNK) : 0;
  await run('DELETE FROM media_chunks WHERE media_id = ?', [id]);
  for (let i = 0; i < chunks; i++) await run('INSERT INTO media_chunks (media_id, seq, data) VALUES (?, ?, ?)', [id, i, buf.subarray(i * CHUNK, (i + 1) * CHUNK)]);
  await run('UPDATE media SET data = ?, chunks = ?, drive_file_id = NULL WHERE id = ?', [video ? Buffer.alloc(0) : buf, chunks, id]);
}

/** Detects MP4, MOV and WebM video from the first bytes. */
export function sniffVideo(buf: Buffer): string | null {
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return buf.subarray(8, 12).toString('ascii') === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return null;
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
export const MAX_VIDEO = 100_000_000;
const CHUNK = 4_000_000;

/**
 * Saves an image or video to the media library. It goes to the workspace's Google Drive when one
 * is connected, and otherwise into the database, so it survives redeploys either way. If Drive
 * fails, the file is kept in Surecast so the upload still works, and Settings shows the problem.
 */
export async function storeMedia(workspaceId: string, buf: Buffer, name: string, alt = '') {
  const video = sniffVideo(buf);
  const mime = video ?? sniffImage(buf);
  if (!mime) throw new HttpError(422, 'Use a JPEG, PNG, GIF or WebP image, or an MP4, MOV or WebM video.');
  if (!video && buf.length > MAX_UPLOAD) throw new HttpError(413, 'Images can be up to 10 MB.');
  if (video && buf.length > MAX_VIDEO) throw new HttpError(413, 'Videos can be up to 100 MB.');
  const id = newId('med');
  const key = token(18);
  const filename = (name || (video ? 'video' : 'image')).replace(/[^\w.\- ]+/g, '').slice(0, 190) || 'file';
  const drive = await getDrive(workspaceId);
  let driveFileId: string | null = null;
  if (drive) driveFileId = await uploadToDrive(drive, buf, filename, mime).catch(() => null);
  await run('INSERT INTO media (id, workspace_id, public_key, filename, mime, size, alt, data, chunks, drive_file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)', [
    id,
    workspaceId,
    key,
    filename,
    mime,
    buf.length,
    alt || null,
    Buffer.alloc(0),
    driveFileId,
    new Date(),
  ]);
  if (!driveFileId) await storeBytes(id, buf);
  return { id, filename, mime, key, storage: driveFileId ? ('drive' as const) : ('surecast' as const) };
}
