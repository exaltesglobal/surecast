// Loading channels for adapters, and recording how each connection is doing.
import { all, one, run, type Row } from '../db.js';
import { adapter, PublishError, type ChannelCtx } from '../platforms/index.js';
import { clip, decrypt, encrypt } from '../util.js';
import { raiseAlert, resolveAlerts } from './alerts.js';

export type ChannelRow = Row & {
  id: string;
  workspace_id: string;
  client_id: string;
  platform: string;
  name: string;
  handle: string;
  external_id: string;
  credentials: string;
  status: 'ok' | 'expiring' | 'failing' | 'disconnected';
  token_expires_at: Date | null;
  last_checked_at: Date | null;
  consecutive_failures: number;
};

export function channelCtx(ch: ChannelRow): ChannelCtx {
  const ctx: ChannelCtx = {
    id: ch.id,
    handle: ch.handle,
    externalId: ch.external_id,
    credentials: decrypt<Record<string, unknown>>(ch.credentials),
    tokenExpiresAt: ch.token_expires_at,
    async saveCredentials(credentials, tokenExpiresAt) {
      ctx.credentials = credentials;
      if (tokenExpiresAt) ctx.tokenExpiresAt = tokenExpiresAt;
      await run('UPDATE channels SET credentials = ?, token_expires_at = COALESCE(?, token_expires_at) WHERE id = ?', [encrypt(credentials), tokenExpiresAt, ch.id]);
    },
  };
  return ctx;
}

export const getChannel = (id: string) => one<ChannelRow>('SELECT * FROM channels WHERE id = ?', [id]);

const EXPIRY_WARNING_MS = 7 * 86_400_000;

/** A successful post or check: the connection works. */
export async function channelOk(ch: ChannelRow, now = new Date()) {
  const expiring = ch.token_expires_at && ch.token_expires_at.getTime() - now.getTime() < EXPIRY_WARNING_MS;
  await run("UPDATE channels SET status = ?, status_detail = ?, last_ok_at = ?, last_checked_at = ?, consecutive_failures = 0 WHERE id = ?", [
    expiring ? 'expiring' : 'ok',
    expiring ? 'Connection expires soon. Reconnect to renew it.' : null,
    now,
    now,
    ch.id,
  ]);
  if (ch.status === 'disconnected' || ch.status === 'failing') await resolveAlerts(ch.workspace_id, [`channel:${ch.id}:disconnected`, `channel:${ch.id}:failing`]);
}

/** A failed post or check. Auth failures disconnect the channel; repeated temporary ones mark it failing. */
export async function channelFailed(ch: ChannelRow, err: PublishError, now = new Date()) {
  if (err.kind === 'auth') {
    await run("UPDATE channels SET status = 'disconnected', status_detail = ?, last_checked_at = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?", [clip(err.hint, 500), now, ch.id]);
    await raiseAlert({
      workspaceId: ch.workspace_id,
      key: `channel:${ch.id}:disconnected`,
      kind: 'channel_disconnected',
      severity: 'error',
      title: `${adapter(ch.platform).label} channel "${ch.name}" is disconnected`,
      detail: `${err.message}. ${err.hint}`,
      clientId: ch.client_id,
      channelId: ch.id,
    });
    return;
  }
  const failures = ch.consecutive_failures + 1;
  const failing = err.kind === 'temporary' && failures >= 3;
  if (failing)
    await run("UPDATE channels SET status = 'failing', status_detail = ?, last_checked_at = ?, consecutive_failures = ? WHERE id = ?", [clip(`${err.message}. ${err.hint}`, 500), now, failures, ch.id]);
  else await run('UPDATE channels SET last_checked_at = ?, consecutive_failures = ? WHERE id = ?', [now, failures, ch.id]);
  if (failing)
    await raiseAlert({
      workspaceId: ch.workspace_id,
      key: `channel:${ch.id}:failing`,
      kind: 'channel_failing',
      severity: 'warning',
      title: `${adapter(ch.platform).label} channel "${ch.name}" keeps failing`,
      detail: `${failures} failures in a row. Last: ${err.message}`,
      clientId: ch.client_id,
      channelId: ch.id,
    });
}

/** Runs the adapter's connection check and records the result. */
export async function checkChannel(ch: ChannelRow, now = new Date()): Promise<{ ok: boolean; message?: string }> {
  try {
    const ctx = channelCtx(ch);
    const info = await adapter(ch.platform).check(ctx);
    if (info.name || info.avatarUrl !== undefined)
      await run('UPDATE channels SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url) WHERE id = ?', [info.name ?? null, info.avatarUrl ?? null, ch.id]);
    if (info.tokenExpiresAt !== undefined) {
      await run('UPDATE channels SET token_expires_at = ? WHERE id = ?', [info.tokenExpiresAt, ch.id]);
      ch.token_expires_at = info.tokenExpiresAt;
    } else if (ctx.tokenExpiresAt !== ch.token_expires_at) ch.token_expires_at = ctx.tokenExpiresAt;
    await channelOk(ch, now);
    return { ok: true };
  } catch (e) {
    const err = e instanceof PublishError ? e : new PublishError('temporary', 'check_failed', (e as Error).message, 'Surecast will check again later.');
    await channelFailed(ch, err, now);
    return { ok: false, message: `${err.message}. ${err.hint}` };
  }
}

/** Health checks every 6 hours, and warnings for tokens that expire within a week. */
export async function sweepChannels(now = new Date()) {
  const stale = await all<ChannelRow>('SELECT * FROM channels WHERE last_checked_at IS NULL OR last_checked_at < ? ORDER BY last_checked_at LIMIT 25', [new Date(now.getTime() - 6 * 3_600_000)]);
  for (const ch of stale) await checkChannel(ch, now);

  const expiring = await all<ChannelRow>("SELECT * FROM channels WHERE token_expires_at IS NOT NULL AND token_expires_at < ? AND status <> 'disconnected'", [new Date(now.getTime() + EXPIRY_WARNING_MS)]);
  for (const ch of expiring) {
    const days = Math.max(0, Math.ceil((ch.token_expires_at!.getTime() - now.getTime()) / 86_400_000));
    const expired = ch.token_expires_at!.getTime() <= now.getTime();
    await run('UPDATE channels SET status = ?, status_detail = ? WHERE id = ?', [
      expired ? 'disconnected' : 'expiring',
      expired ? 'The connection has expired. Reconnect this channel.' : `Connection expires in ${days} day${days === 1 ? '' : 's'}. Reconnect to renew it.`,
      ch.id,
    ]);
    await raiseAlert({
      workspaceId: ch.workspace_id,
      key: `channel:${ch.id}:${expired ? 'disconnected' : 'expiring'}`,
      kind: expired ? 'channel_disconnected' : 'token_expiring',
      severity: expired ? 'error' : 'warning',
      title: expired ? `${adapter(ch.platform).label} channel "${ch.name}" has expired` : `${adapter(ch.platform).label} channel "${ch.name}" expires in ${days} day${days === 1 ? '' : 's'}`,
      detail: 'Reconnect it from the Channels page so scheduled posts keep going out.',
      clientId: ch.client_id,
      channelId: ch.id,
    });
  }
}
