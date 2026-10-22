import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

import { config } from './config.js';

const ALPHA = 'abcdefghijkmnopqrstuvwxyz23456789';

export function randomString(length: number, alphabet = ALPHA) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Short prefixed ids, e.g. "pst_k3m9...". */
export const newId = (prefix: string) => `${prefix}_${randomString(16)}`;

export const token = (bytes = 24) => randomBytes(bytes).toString('base64url');

/** Keyed hash for codes, sessions and API keys, so a database leak does not reveal them. */
export const hashSecret = (value: string) => createHash('sha256').update(`${config.appSecret}:${value}`).digest('hex');

export const hmac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest('hex');

const key = () => createHash('sha256').update(`credentials:${config.appSecret}`).digest();

/** Channel credentials are encrypted at rest with AES-256-GCM. */
export function encrypt(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

export function decrypt<T>(blob: string): T {
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !data) throw new Error('Unreadable credentials');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8')) as T;
}

export const minutes = (n: number) => n * 60_000;
export const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);

export function isEmail(v: unknown): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 190;
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s);

function tzOffsetMs(ts: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ts / 1000) * 1000;
}

/** The UTC instant of a wall-clock time in a time zone. */
export function zonedToUtc(y: number, month: number, d: number, h: number, mi: number, timeZone: string) {
  const guess = Date.UTC(y, month - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, timeZone);
  return new Date(guess - tzOffsetMs(first, timeZone));
}

/** Start and end (exclusive) of a "YYYY-MM" month in a time zone. */
export function monthRange(month: string, timeZone: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  const now = new Date();
  const y = m ? Number(m[1]) : now.getUTCFullYear();
  const mo = m ? Number(m[2]) : now.getUTCMonth() + 1;
  return { from: zonedToUtc(y, mo, 1, 0, 0, timeZone), to: zonedToUtc(mo === 12 ? y + 1 : y, mo === 12 ? 1 : mo + 1, 1, 0, 0, timeZone), label: `${y}-${String(mo).padStart(2, '0')}` };
}
