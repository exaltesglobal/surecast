// Shared HTTP helper for adapters. It turns network failures and HTTP errors into
// PublishErrors with a sensible default kind, which adapters can refine.
import { PublishError } from './types.js';

export type HttpOptions = {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: BodyInit;
  timeoutMs?: number;
};

export type HttpResponse<T> = { status: number; data: T; headers: Headers };

export async function http<T = any>(platform: string, url: string, opts: HttpOptions = {}): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { 'User-Agent': 'Surecast/0.1 (+https://surecast.live)', ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new PublishError(
      'temporary',
      timeout ? 'timeout' : 'network',
      timeout ? `${platform} did not answer in time` : `Could not reach ${platform}: ${(e as Error).message}`,
      `Surecast will retry automatically. If it keeps happening, ${platform} may be having an outage.`,
    );
  }
  const text = await res.text();
  let data: any = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const err = httpError(platform, res.status, data, res.headers);
    err.body = data;
    throw err;
  }
  return { status: res.status, data: data as T, headers: res.headers };
}

/** Pulls a readable message out of the many error shapes platforms use. */
export function errorText(data: any): string {
  if (!data) return '';
  if (typeof data === 'string') return data.slice(0, 300);
  return String(
    data.error_description ??
      data.message ??
      data.error?.message ??
      data.error?.error_user_msg ??
      data.detail ??
      data.description ??
      data.errors?.[0]?.message ??
      data.title ??
      (typeof data.error === 'string' ? data.error : '') ??
      '',
  ).slice(0, 300);
}

export function httpError(platform: string, status: number, data: any, headers?: Headers): PublishError {
  const detail = errorText(data);
  const msg = `${platform} returned ${status}${detail ? `: ${detail}` : ''}`;
  if (status === 401) return new PublishError('auth', 'unauthorized', msg, `The ${platform} connection has expired or was revoked. Reconnect this channel.`, status);
  if (status === 403) return new PublishError('permanent', 'forbidden', msg, `${platform} refused this post. Check the account still has permission to post here.`, status);
  if (status === 429) {
    const ra = headers?.get('retry-after');
    const reset = headers?.get('x-rate-limit-reset') ?? headers?.get('ratelimit-reset');
    let retryAfter: Date | undefined;
    if (ra && /^\d+$/.test(ra)) retryAfter = new Date(Date.now() + Number(ra) * 1000);
    else if (reset && /^\d+$/.test(reset)) retryAfter = new Date(Number(reset) > 1e9 ? Number(reset) * 1000 : Date.now() + Number(reset) * 1000);
    return new PublishError('temporary', 'rate_limited', msg, `${platform} is rate limiting this account. Surecast will retry after the limit resets.`, status, retryAfter);
  }
  if (status >= 500 || status === 408) return new PublishError('temporary', 'server_error', msg, `${platform} had a problem on their side. Surecast will retry automatically.`, status);
  return new PublishError('permanent', 'rejected', msg, `${platform} rejected the post. Edit it and try again.`, status);
}

/** Collects the bytes of every image up front so a slow read cannot stall half-way through a post. */
export async function blobOf(file: { data: () => Promise<Buffer>; mime: string }) {
  const buf = await file.data();
  return new Blob([new Uint8Array(buf)], { type: file.mime });
}
