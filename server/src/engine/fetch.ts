// Fetching addresses that people type in (feeds, image links in a CSV). Only public http(s)
// addresses are allowed, so nobody can point Surecast at the server's own network.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { HttpError } from '../auth.js';

function privateIp(ip: string) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublic(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(422, `"${raw.slice(0, 100)}" is not a valid web address.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(422, 'Only http and https addresses are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length) throw new HttpError(422, `Could not find the server for ${url.hostname}.`);
  if (ips.some(privateIp)) throw new HttpError(422, 'That address points to a private network.');
  return url;
}

export async function fetchPublic(raw: string, opts: { maxBytes: number; accept?: string; timeoutMs?: number }) {
  let url = await assertPublic(raw);
  for (let hop = 0; hop < 4; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Surecast/1.0 (+https://surecast.live)', Accept: opts.accept ?? '*/*' },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new HttpError(422, `Could not reach ${url.hostname}: ${(e as Error).name === 'TimeoutError' ? 'it took too long to answer' : (e as Error).message}.`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = await assertPublic(new URL(res.headers.get('location')!, url).toString());
      continue;
    }
    if (!res.ok) throw new HttpError(422, `${url.hostname} answered with HTTP ${res.status}.`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > opts.maxBytes) throw new HttpError(422, `The file at ${url.hostname} is too large.`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > opts.maxBytes) throw new HttpError(422, `The file at ${url.hostname} is too large.`);
      chunks.push(chunk);
    }
    return { body: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '', url: url.toString() };
  }
  throw new HttpError(422, 'Too many redirects.');
}
