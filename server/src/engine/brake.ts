// The emergency brake. Pausing a client holds every post that has not gone out yet, on every
// channel, in one click: for a crisis, a bereavement, a product recall or a client who stopped
// paying. Nothing is deleted. On resume, each held post either keeps its time (if it is still in
// the future) or, for slots that passed while paused, is skipped, posted now or moved to the
// client's next queue slot, as the person resuming chooses.
import { HttpError, type AuthUser } from '../auth.js';
import { all, one, run, type Row } from '../db.js';
import { clip } from '../util.js';
import { raiseAlert, resolveAlerts } from './alerts.js';
import { rollupPost } from './publisher.js';
import { nextQueueSlot } from './queue.js';
import { emitEvent } from './webhooks.js';

export type MissedMode = 'skip' | 'post_now' | 'queue';
const MODES: MissedMode[] = ['skip', 'post_now', 'queue'];

export const missedMode = (v: unknown): MissedMode => (MODES.includes(v as MissedMode) ? (v as MissedMode) : 'skip');

type ClientRow = Row & { id: string; workspace_id: string; name: string; timezone: string; queue_slots: string | null; paused_at: Date | null; paused_by: string | null };

async function client(workspaceId: string, clientId: string) {
  const c = await one<ClientRow>('SELECT * FROM clients WHERE id = ? AND workspace_id = ?', [clientId, workspaceId]);
  if (!c) throw new HttpError(404, 'Client not found.');
  return c;
}

/** Holds a post's unsent targets if its client is paused. Returns true when it did. */
export async function holdIfPaused(postId: string) {
  const p = await one<{ client_id: string }>('SELECT p.client_id FROM posts p JOIN clients c ON c.id = p.client_id WHERE p.id = ? AND c.paused_at IS NOT NULL', [postId]);
  if (!p) return false;
  // awaiting_approval stays as it is: the client can still approve while paused.
  const n = await run("UPDATE post_targets SET status = 'paused', next_attempt_at = NULL, updated_at = ? WHERE post_id = ? AND status IN ('scheduled', 'retrying')", [new Date(), postId]);
  if (n) await rollupPost(postId);
  return n > 0;
}

export async function pauseClient(
  workspaceId: string,
  clientId: string,
  opts: { reason?: unknown; until?: unknown; missed?: unknown; by: string },
  user: AuthUser | null,
) {
  const c = await client(workspaceId, clientId);
  const reason = typeof opts.reason === 'string' ? opts.reason.trim().slice(0, 500) : '';
  let until: Date | null = null;
  if (typeof opts.until === 'string' && opts.until) {
    until = new Date(opts.until);
    if (Number.isNaN(until.getTime())) throw new HttpError(422, 'That resume date is not valid.');
    if (until.getTime() <= Date.now()) throw new HttpError(422, 'Pick a resume time in the future.');
  }
  const now = new Date();
  await run('UPDATE clients SET paused_at = COALESCE(paused_at, ?), paused_until = ?, paused_reason = ?, paused_by = ?, paused_missed = ? WHERE id = ?', [
    now,
    until,
    reason || null,
    opts.by,
    missedMode(opts.missed),
    c.id,
  ]);
  const posts = await all<{ post_id: string }>(
    "SELECT DISTINCT t.post_id FROM post_targets t JOIN posts p ON p.id = t.post_id WHERE p.client_id = ? AND t.status IN ('scheduled', 'retrying')",
    [c.id],
  );
  const held = await run(
    "UPDATE post_targets t JOIN posts p ON p.id = t.post_id SET t.status = 'paused', t.next_attempt_at = NULL, t.updated_at = ? WHERE p.client_id = ? AND t.status IN ('scheduled', 'retrying')",
    [now, c.id],
  );
  for (const p of posts) await rollupPost(p.post_id);
  await raiseAlert({
    workspaceId,
    key: `client:${c.id}:paused`,
    kind: 'client_paused',
    severity: 'info',
    title: `Publishing for ${c.name} is paused`,
    detail: [reason, until ? `Resumes automatically at ${until.toISOString().slice(0, 16).replace('T', ' ')} UTC.` : 'Resume it from the client page.'].filter(Boolean).join(' '),
    clientId: c.id,
  });
  await emitEvent(workspaceId, 'client.paused', { client_id: c.id, reason, until: until?.toISOString() ?? null, held, by: user?.email ?? opts.by });
  return { held };
}

export async function resumeClient(workspaceId: string, clientId: string, missedIn?: unknown, user: AuthUser | null = null, now = new Date()) {
  const c = await client(workspaceId, clientId);
  if (!c.paused_at) throw new HttpError(409, `${c.name} is not paused.`);
  const missed = missedMode(missedIn ?? c.paused_missed);
  const held = await all<{ id: string; post_id: string; due_at: Date | null }>(
    "SELECT t.id, t.post_id, t.due_at FROM post_targets t JOIN posts p ON p.id = t.post_id WHERE p.client_id = ? AND t.status = 'paused' ORDER BY t.due_at",
    [c.id],
  );
  const counts = { resumed: 0, skipped: 0, postedNow: 0, queued: 0 };
  // Targets of the same post move together, so a queued post keeps one slot for all its channels.
  const newSlot = new Map<string, Date>();
  const taken: Date[] = [];
  for (const t of held) {
    if (t.due_at && t.due_at.getTime() > now.getTime()) {
      await run("UPDATE post_targets SET status = 'scheduled', next_attempt_at = due_at, preflight_at = NULL, updated_at = ? WHERE id = ?", [now, t.id]);
      counts.resumed++;
    } else if (missed === 'skip') {
      await run(
        "UPDATE post_targets SET status = 'cancelled', error_code = 'skipped_while_paused', error_message = 'The slot passed while the client was paused', error_hint = 'Reschedule it if it should still go out.', updated_at = ? WHERE id = ?",
        [now, t.id],
      );
      counts.skipped++;
    } else if (missed === 'post_now') {
      await run("UPDATE post_targets SET status = 'scheduled', due_at = ?, next_attempt_at = ?, attempts = 0, preflight_at = NULL, updated_at = ? WHERE id = ?", [now, now, now, t.id]);
      counts.postedNow++;
    } else {
      let at = newSlot.get(t.post_id);
      if (!at) {
        at = await nextQueueSlot(c, now, taken).catch(() => null) ?? undefined;
        if (!at) throw new HttpError(422, `${c.name} has no posting times to queue the missed posts into. Choose "skip" or "post now" instead.`);
        newSlot.set(t.post_id, at);
        taken.push(at);
        await run('UPDATE posts SET scheduled_at = ? WHERE id = ?', [at, t.post_id]);
      }
      await run("UPDATE post_targets SET status = 'scheduled', due_at = ?, next_attempt_at = ?, attempts = 0, preflight_at = NULL, updated_at = ? WHERE id = ?", [at, at, now, t.id]);
      counts.queued++;
    }
  }
  await run('UPDATE clients SET paused_at = NULL, paused_until = NULL, paused_reason = NULL, paused_by = NULL, paused_missed = NULL WHERE id = ?', [c.id]);
  for (const id of new Set(held.map((t) => t.post_id))) await rollupPost(id);
  await resolveAlerts(workspaceId, [`client:${c.id}:paused`]);
  await emitEvent(workspaceId, 'client.resumed', { client_id: c.id, missed, ...counts, by: user?.email ?? 'schedule' });
  return { missed, ...counts };
}

/** Clients whose pause has a resume time that has come. */
export async function autoResume(now = new Date()) {
  const due = await all<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM clients WHERE paused_at IS NOT NULL AND paused_until IS NOT NULL AND paused_until <= ?', [now]);
  for (const c of due) {
    try {
      await resumeClient(c.workspace_id, c.id, undefined, null, now);
    } catch (e) {
      // Usually "no posting times" for queue mode: fall back to skipping, and say so.
      const r = await resumeClient(c.workspace_id, c.id, 'skip', null, now);
      await raiseAlert({
        workspaceId: c.workspace_id,
        key: `client:${c.id}:resume`,
        kind: 'client_resumed',
        severity: 'warning',
        title: 'A paused client resumed, but missed posts could not be queued',
        detail: clip(`${(e as Error).message} ${r.skipped} missed posts were skipped instead.`, 900) ?? undefined,
        clientId: c.id,
      });
    }
  }
  return due.length;
}

export const pauseJson = (c: Row) =>
  c.paused_at ? { at: c.paused_at, until: c.paused_until ?? null, reason: c.paused_reason ?? '', by: c.paused_by ?? '', missed: missedMode(c.paused_missed) } : null;
