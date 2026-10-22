// The publishing engine. Each post goes to each of its channels as a separate "target",
// and every attempt is recorded. The engine runs on a tick (every 20 seconds in-process,
// plus every minute from the hPanel cron job) and is safe to run concurrently: a target is
// claimed with a conditional UPDATE, so it can only be picked up once.
//
// Target lifecycle:
//   draft -> awaiting_approval -> scheduled -> publishing -> published
//                                          \-> retrying -> publishing ...
//                                          \-> failed (permanent error, retries used up, or missed slot)
import { config } from '../config.js';
import { all, one, run, type Row } from '../db.js';
import { adapter, PublishError } from '../platforms/index.js';
import { addMs, clip, minutes, newId, token } from '../util.js';
import { emailAlerts, raiseAlert, resolveAlerts } from './alerts.js';
import { channelCtx, channelFailed, channelOk, checkChannel, getChannel, sweepChannels, type ChannelRow } from './channels.js';
import { contentIssues, mediaFiles, mediaMeta } from './content.js';
import { emitEvent } from './webhooks.js';

export type TargetRow = Row & {
  id: string;
  post_id: string;
  workspace_id: string;
  channel_id: string;
  body_override: string | null;
  status: string;
  due_at: Date | null;
  next_attempt_at: Date | null;
  attempts: number;
  lock_token: string | null;
};

type PostRow = Row & { id: string; workspace_id: string; client_id: string; body: string; media_ids: string; status: string };

/** Delay before retry n (1-based). Six attempts span about 1 hour 36 minutes, inside the late limit. */
const BACKOFF = [minutes(1), minutes(5), minutes(15), minutes(30), minutes(45)];
export const MAX_ATTEMPTS = BACKOFF.length + 1;
const LOCK_MS = minutes(5);
const PREFLIGHT_WINDOW = minutes(15);
const DISCONNECTED_RECHECK = minutes(10);

const ACTIVE = ['scheduled', 'publishing', 'retrying'];

/** Derives a post's overall status from its targets. */
export async function rollupPost(postId: string) {
  const post = await one<PostRow>('SELECT * FROM posts WHERE id = ?', [postId]);
  if (!post) return;
  const statuses = (await all<{ status: string }>('SELECT status FROM post_targets WHERE post_id = ?', [postId])).map((r) => r.status).filter((s) => s !== 'cancelled');
  let status: string;
  if (!statuses.length) status = post.status === 'draft' ? 'draft' : 'cancelled';
  else if (statuses.includes('draft')) status = 'draft';
  else if (statuses.includes('awaiting_approval')) status = post.approval_status === 'changes_requested' ? 'changes_requested' : 'awaiting_approval';
  else if (statuses.some((s) => s === 'publishing' || s === 'retrying') || (statuses.some((s) => ACTIVE.includes(s)) && statuses.some((s) => !ACTIVE.includes(s)))) status = 'publishing';
  else if (statuses.every((s) => s === 'scheduled')) status = 'scheduled';
  else if (statuses.every((s) => s === 'published')) status = 'published';
  else if (statuses.every((s) => s === 'failed')) status = 'failed';
  else status = 'partial';
  if (status !== post.status) await run('UPDATE posts SET status = ?, updated_at = ? WHERE id = ?', [status, new Date(), postId]);
}

async function context(t: TargetRow) {
  const post = (await one<PostRow>('SELECT * FROM posts WHERE id = ?', [t.post_id]))!;
  const channel = (await getChannel(t.channel_id))!;
  const ids = JSON.parse(post.media_ids || '[]') as string[];
  const meta = await mediaMeta(ids);
  const text = t.body_override ?? post.body;
  return { post, channel, meta, text };
}

const clientName = async (clientId: string) => (await one<{ name: string }>('SELECT name FROM clients WHERE id = ?', [clientId]))?.name ?? 'client';

async function fail(t: TargetRow, post: PostRow, channel: ChannelRow | null, err: { code: string; message: string; hint: string }, now: Date) {
  await run("UPDATE post_targets SET status = 'failed', lock_token = NULL, locked_until = NULL, next_attempt_at = NULL, error_code = ?, error_message = ?, error_hint = ?, updated_at = ? WHERE id = ?", [
    err.code,
    clip(err.message, 1000),
    clip(err.hint, 500),
    now,
    t.id,
  ]);
  const label = channel ? `${adapter(channel.platform).label} (${channel.name})` : 'a channel';
  await raiseAlert({
    workspaceId: t.workspace_id,
    key: `target:${t.id}:failed`,
    kind: 'post_failed',
    severity: 'error',
    title: `Post for ${await clientName(post.client_id)} did not go out on ${label}`,
    detail: `${err.message}. ${err.hint}`,
    clientId: post.client_id,
    channelId: t.channel_id,
    postId: post.id,
    targetId: t.id,
  });
  await emitEvent(t.workspace_id, 'post.failed', { post_id: post.id, target_id: t.id, channel_id: t.channel_id, error: err });
  await rollupPost(post.id);
}

/** Claims one due target and publishes it. Returns false if someone else had it. */
export async function publishTarget(targetId: string, now = new Date()): Promise<boolean> {
  const lock = token(9);
  const claimed = await run(
    "UPDATE post_targets SET status = 'publishing', lock_token = ?, locked_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('scheduled', 'retrying') AND next_attempt_at <= ?",
    [lock, addMs(now, LOCK_MS), now, targetId, now],
  );
  if (!claimed) return false;
  // "now" can be in the future in tests; keep the clock moving from there.
  const started = Date.now();
  const clock = () => new Date(now.getTime() + Date.now() - started);
  const t = (await one<TargetRow>('SELECT * FROM post_targets WHERE id = ?', [targetId]))!;
  const { post, channel, meta, text } = await context(t);
  if (!channel) {
    await fail(t, post, null, { code: 'channel_removed', message: 'The channel was removed', hint: 'Pick another channel for this post.' }, now);
    return true;
  }
  const a = adapter(channel.platform);
  await rollupPost(post.id);

  // A disconnected channel cannot succeed. Wait for it to be reconnected (the watchdog
  // gives up once the slot is too late) instead of burning attempts.
  if (channel.status === 'disconnected') {
    await run("UPDATE post_targets SET status = 'retrying', attempts = attempts - 1, lock_token = NULL, locked_until = NULL, next_attempt_at = ?, error_code = 'channel_disconnected', error_message = ?, error_hint = ?, updated_at = ? WHERE id = ?", [
      addMs(now, DISCONNECTED_RECHECK),
      'Waiting: the channel is disconnected',
      'Reconnect the channel and this post will go out automatically.',
      now,
      t.id,
    ]);
    await raiseAlert({
      workspaceId: t.workspace_id,
      key: `target:${t.id}:waiting`,
      kind: 'post_waiting',
      severity: 'error',
      title: `A post for ${await clientName(post.client_id)} is waiting: ${a.label} channel "${channel.name}" is disconnected`,
      detail: 'Reconnect the channel and the post will go out automatically.',
      clientId: post.client_id,
      channelId: channel.id,
      postId: post.id,
      targetId: t.id,
    });
    await rollupPost(post.id);
    return true;
  }

  const issues = contentIssues(a, text, meta);
  if (issues.length) {
    await run("INSERT INTO attempts (id, target_id, number, started_at, finished_at, outcome, error_code, message) VALUES (?, ?, ?, ?, ?, 'permanent_error', 'invalid_content', ?)", [
      newId('att'),
      t.id,
      t.attempts,
      now,
      now,
      clip(issues.join(' '), 1000),
    ]);
    await fail(t, post, channel, { code: 'invalid_content', message: issues.join(' '), hint: `Edit the post to fit ${a.label}'s limits, then retry.` }, now);
    return true;
  }

  const attemptId = newId('att');
  await run("INSERT INTO attempts (id, target_id, number, started_at, outcome) VALUES (?, ?, ?, ?, 'running')", [attemptId, t.id, t.attempts, now]);
  try {
    const result = await a.publish(channelCtx(channel), { text, media: mediaFiles(meta), idempotencyKey: `${t.id}` });
    const done = clock();
    await run("UPDATE attempts SET finished_at = ?, outcome = 'success' WHERE id = ?", [done, attemptId]);
    await run(
      "UPDATE post_targets SET status = 'published', lock_token = NULL, locked_until = NULL, next_attempt_at = NULL, remote_id = ?, remote_url = ?, published_at = ?, error_code = NULL, error_message = NULL, error_hint = NULL, updated_at = ? WHERE id = ? AND lock_token = ?",
      [clip(result.remoteId, 190), clip(result.url, 500), done, done, t.id, lock],
    );
    await channelOk(channel, done);
    await resolveAlerts(t.workspace_id, [`target:${t.id}:failed`, `target:${t.id}:waiting`, `target:${t.id}:preflight`]);
    await emitEvent(t.workspace_id, 'post.published', { post_id: post.id, target_id: t.id, channel_id: channel.id, url: result.url, published_at: done.toISOString() });
  } catch (e) {
    const err =
      e instanceof PublishError ? e : new PublishError('temporary', 'unexpected', (e as Error).message || 'Unexpected error', 'Surecast will retry automatically. If it keeps failing, contact support.');
    const done = clock();
    await run('UPDATE attempts SET finished_at = ?, outcome = ?, error_code = ?, http_status = ?, message = ? WHERE id = ?', [
      done,
      err.kind === 'temporary' ? 'temporary_error' : err.kind === 'auth' ? 'auth_error' : 'permanent_error',
      err.code,
      err.httpStatus ?? null,
      clip(err.message, 1000),
      attemptId,
    ]);
    await channelFailed(channel, err, done);
    if (err.kind === 'auth') {
      // The channel is now disconnected; the next pass waits for it to be reconnected.
      await run("UPDATE post_targets SET status = 'retrying', lock_token = NULL, locked_until = NULL, next_attempt_at = ?, error_code = ?, error_message = ?, error_hint = ?, updated_at = ? WHERE id = ?", [
        addMs(done, DISCONNECTED_RECHECK),
        err.code,
        clip(err.message, 1000),
        clip(err.hint, 500),
        done,
        t.id,
      ]);
    } else if (err.kind === 'temporary' && t.attempts < MAX_ATTEMPTS) {
      let next = addMs(done, BACKOFF[t.attempts - 1]);
      if (err.retryAfter && err.retryAfter > next) next = err.retryAfter;
      await run("UPDATE post_targets SET status = 'retrying', lock_token = NULL, locked_until = NULL, next_attempt_at = ?, error_code = ?, error_message = ?, error_hint = ?, updated_at = ? WHERE id = ?", [
        next,
        err.code,
        clip(err.message, 1000),
        clip(err.hint, 500),
        done,
        t.id,
      ]);
    } else {
      const gaveUp = err.kind === 'temporary';
      await fail(
        t,
        post,
        channel,
        {
          code: err.code,
          message: gaveUp ? `Gave up after ${t.attempts} attempts. Last error: ${err.message}` : err.message,
          hint: gaveUp ? `${err.hint} You can retry it from the post.` : err.hint,
        },
        done,
      );
      return true;
    }
  }
  await rollupPost(post.id);
  return true;
}

/** Targets left "publishing" by a crash or restart. */
async function recoverStale(now: Date) {
  const stale = await all<TargetRow>("SELECT * FROM post_targets WHERE status = 'publishing' AND locked_until < ?", [now]);
  for (const t of stale) {
    const { post, channel } = await context(t);
    await run("UPDATE attempts SET finished_at = ?, outcome = 'interrupted', message = 'Interrupted (server restart)' WHERE target_id = ? AND outcome = 'running'", [now, t.id]);
    if (channel && adapter(channel.platform).idempotent) {
      // Safe to repeat: the platform drops a duplicate request with the same key.
      await run("UPDATE post_targets SET status = 'retrying', lock_token = NULL, locked_until = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'publishing'", [now, now, t.id]);
    } else {
      // We cannot tell whether it went out, and retrying might post twice. Ask a person.
      await fail(
        t,
        post,
        channel,
        {
          code: 'interrupted',
          message: 'Publishing was interrupted, so we cannot confirm whether the post went out',
          hint: 'Check the channel. If the post is not there, press Retry.',
        },
        now,
      );
    }
  }
}

/** Fifteen minutes before a slot, confirm the post and its channel are good to go. */
async function preflight(now: Date) {
  const due = await all<TargetRow>("SELECT * FROM post_targets WHERE status = 'scheduled' AND preflight_at IS NULL AND due_at <= ? LIMIT 50", [addMs(now, PREFLIGHT_WINDOW)]);
  const checked = new Map<string, { ok: boolean; message?: string }>();
  for (const t of due) {
    const { post, channel, meta, text } = await context(t);
    if (!channel) continue;
    const a = adapter(channel.platform);
    const problems = contentIssues(a, text, meta);
    if (!checked.has(channel.id)) {
      const recent = channel.last_checked_at && now.getTime() - channel.last_checked_at.getTime() < minutes(30) && channel.status !== 'disconnected';
      checked.set(channel.id, recent ? { ok: true } : await checkChannel(channel, now));
    }
    const ch = checked.get(channel.id)!;
    if (!ch.ok) problems.push(`The ${a.label} connection failed its check: ${ch.message}`);
    const ok = !problems.length;
    await run('UPDATE post_targets SET preflight_at = ?, preflight_ok = ?, preflight_message = ? WHERE id = ?', [now, ok ? 1 : 0, ok ? null : clip(problems.join(' '), 500), t.id]);
    if (!ok)
      await raiseAlert({
        workspaceId: t.workspace_id,
        key: `target:${t.id}:preflight`,
        kind: 'preflight_failed',
        severity: 'warning',
        title: `A post for ${await clientName(post.client_id)} on ${a.label} will probably fail`,
        detail: `${problems.join(' ')} Fix it before ${t.due_at?.toISOString().slice(11, 16)} UTC.`,
        clientId: post.client_id,
        channelId: channel.id,
        postId: post.id,
        targetId: t.id,
      });
  }
}

/** Slots that passed without the post going out. */
async function watchdog(now: Date) {
  const late = addMs(now, -minutes(config.lateLimitMinutes));
  const unapproved = await all<TargetRow>("SELECT * FROM post_targets WHERE status = 'awaiting_approval' AND due_at <= ?", [now]);
  for (const t of unapproved) {
    const { post, channel } = await context(t);
    await fail(t, post, channel, { code: 'not_approved', message: 'The client had not approved this post by its scheduled time', hint: 'Get it approved, then reschedule it.' }, now);
  }
  const missed = await all<TargetRow>("SELECT * FROM post_targets WHERE status IN ('scheduled', 'retrying') AND due_at < ?", [late]);
  for (const t of missed) {
    const { post, channel } = await context(t);
    const waiting = t.error_code === 'channel_disconnected' || channel?.status === 'disconnected';
    await fail(
      t,
      post,
      channel,
      waiting
        ? { code: 'channel_disconnected', message: `The channel stayed disconnected for more than ${config.lateLimitMinutes} minutes after the slot`, hint: 'Reconnect the channel, then retry or reschedule the post.' }
        : t.status === 'retrying'
          ? { code: t.error_code ?? 'gave_up', message: `Still failing ${config.lateLimitMinutes} minutes after the slot: ${t.error_message ?? ''}`, hint: 'Retry it, or reschedule it.' }
          : { code: 'missed_slot', message: `The slot passed more than ${config.lateLimitMinutes} minutes ago while Surecast was not running`, hint: 'Nothing was posted. Post it now or pick a new time.' },
      now,
    );
  }
}

let running: Promise<TickResult> | null = null;
export type TickResult = { published: number; source: string };

/** One pass of the scheduler. Concurrent calls in the same process share one pass. */
export function tick(source = 'interval', now = () => new Date()): Promise<TickResult> {
  running ??= (async () => {
    let published = 0;
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        console.error(`Scheduler step "${name}" failed`, e);
      }
    };
    await step('heartbeat', () =>
      run('INSERT INTO scheduler_runs (id, last_tick_at, last_source) VALUES (1, ?, ?) ON DUPLICATE KEY UPDATE last_tick_at = VALUES(last_tick_at), last_source = VALUES(last_source)', [now(), source]),
    );
    await step('recover', () => recoverStale(now()));
    await step('watchdog', () => watchdog(now()));
    await step('publish', async () => {
      const due = await all<{ id: string; channel_id: string }>("SELECT id, channel_id FROM post_targets WHERE status IN ('scheduled', 'retrying') AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 40", [now()]);
      // Different channels publish in parallel; posts on the same channel go one at a time, in order.
      const byChannel = new Map<string, string[]>();
      for (const d of due) byChannel.set(d.channel_id, [...(byChannel.get(d.channel_id) ?? []), d.id]);
      const queues = [...byChannel.values()];
      const worker = async () => {
        for (let q = queues.shift(); q; q = queues.shift())
          for (const id of q) {
            try {
              if (await publishTarget(id, now())) published++;
            } catch (e) {
              console.error(`Publishing target ${id} failed unexpectedly`, e);
            }
          }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
    });
    await step('preflight', () => preflight(now()));
    await step('channels', () => sweepChannels(now()));
    await step('email', () => emailAlerts());
    return { published, source };
  })().finally(() => (running = null));
  return running;
}

export async function lastTick() {
  return one<{ last_tick_at: Date; last_source: string }>('SELECT last_tick_at, last_source FROM scheduler_runs WHERE id = 1');
}
