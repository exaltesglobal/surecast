// Follow-ups go out after the main post: the rest of a thread, then the first comment.
// They run on their own small queue so a failed follow-up never puts the main post at risk,
// and a retry carries on from the part that failed instead of starting the thread again.
import { all, json, one, run, type Row } from '../db.js';
import { adapter, PublishError, type Adapter } from '../platforms/index.js';
import { addMs, clip, minutes } from '../util.js';
import { raiseAlert, resolveAlerts } from './alerts.js';
import { channelCtx, channelFailed, getChannel } from './channels.js';
import { prepareLinks } from './links.js';

export type FollowUp = { kind: 'thread' | 'comment'; text: string };

const BACKOFF = [minutes(1), minutes(5), minutes(15)];
const MAX_ATTEMPTS = BACKOFF.length + 1;
const LOCK_MS = minutes(5);

export function threadParts(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? json<unknown[]>(v, []) : [];
  return parts.filter((p): p is string => typeof p === 'string' && !!p.trim()).slice(0, 25);
}

/** What follows the main post on this network. Threads only go to networks that have them. */
export function followUpsFor(a: Adapter, post: { thread?: unknown; first_comment?: unknown; [k: string]: unknown }): FollowUp[] {
  if (!a.followUps || !a.reply) return [];
  const items: FollowUp[] = a.followUps === 'thread' ? threadParts(post.thread).map((text) => ({ kind: 'thread', text })) : [];
  if (typeof post.first_comment === 'string' && post.first_comment.trim()) items.push({ kind: 'comment', text: post.first_comment });
  return items;
}

export async function runFollowUps(now: Date) {
  const due = await all<Row>(
    "SELECT * FROM post_targets WHERE status = 'published' AND followups_done < followups_total AND followups_next_at IS NOT NULL AND followups_next_at <= ? ORDER BY followups_next_at LIMIT 20",
    [now],
  );
  for (const t of due) {
    const claimed = await run('UPDATE post_targets SET followups_next_at = ? WHERE id = ? AND followups_next_at = ?', [addMs(now, LOCK_MS), t.id, t.followups_next_at]);
    if (claimed) await sendFollowUps(t, now);
  }
}

async function sendFollowUps(t: Row, now: Date) {
  const post = await one<Row>('SELECT * FROM posts WHERE id = ?', [t.post_id]);
  const channel = await getChannel(t.channel_id);
  if (!post || !channel) return run('UPDATE post_targets SET followups_next_at = NULL WHERE id = ?', [t.id]);
  const a = adapter(channel.platform);
  const items = followUpsFor(a, post);
  const ids = json<string[]>(t.followups_ids, []);
  let done: number = t.followups_done;
  for (; done < Math.min(t.followups_total, items.length); done++) {
    const item = items[done];
    const parentId = item.kind === 'comment' ? t.remote_id : (ids[done - 1] ?? t.remote_id);
    try {
      const text = await prepareLinks(item.text, { workspaceId: t.workspace_id, clientId: post.client_id, postId: post.id, targetId: t.id, platform: channel.platform });
      const r = await a.reply!(channelCtx(channel), { parentId, rootId: t.remote_id }, text, `${t.id}-f${done}`);
      ids[done] = r.remoteId;
      await run('UPDATE post_targets SET followups_done = ?, followups_ids = ?, followups_attempts = 0, followups_error = NULL WHERE id = ?', [done + 1, JSON.stringify(ids), t.id]);
    } catch (e) {
      const err = e instanceof PublishError ? e : new PublishError('temporary', 'unexpected', (e as Error).message || 'Unexpected error', 'Surecast will try again.');
      const attempts = t.followups_attempts + 1;
      const again = err.kind === 'temporary' && attempts < MAX_ATTEMPTS;
      const what = item.kind === 'comment' ? 'The first comment' : `Part ${done + 2} of the thread`;
      await run('UPDATE post_targets SET followups_attempts = ?, followups_next_at = ?, followups_error = ? WHERE id = ?', [
        again ? attempts : 0,
        again ? addMs(now, BACKOFF[attempts - 1]) : null,
        clip(`${what} did not go out: ${err.message}`, 1000),
        t.id,
      ]);
      if (err.kind === 'auth') await channelFailed(channel, err, now);
      if (!again) {
        const client = await one<{ name: string }>('SELECT name FROM clients WHERE id = ?', [post.client_id]);
        await raiseAlert({
          workspaceId: t.workspace_id,
          key: `target:${t.id}:followups`,
          kind: 'followup_failed',
          severity: 'warning',
          title: `${what} for ${client?.name ?? 'a client'} did not go out on ${a.label}`,
          detail: `The main post is live. ${err.message}. ${err.hint} Open the post to try the rest again.`,
          clientId: post.client_id,
          channelId: channel.id,
          postId: post.id,
          targetId: t.id,
        });
      }
      return;
    }
  }
  await run('UPDATE post_targets SET followups_next_at = NULL WHERE id = ?', [t.id]);
  await resolveAlerts(t.workspace_id, [`target:${t.id}:followups`]);
}

/** "Try again" on a post whose thread or first comment did not finish. */
export async function retryFollowUps(workspaceId: string, postId: string) {
  return run(
    'UPDATE post_targets SET followups_next_at = ?, followups_attempts = 0, followups_error = NULL WHERE post_id = ? AND workspace_id = ? AND status = \'published\' AND followups_done < followups_total',
    [new Date(), postId, workspaceId],
  );
}
