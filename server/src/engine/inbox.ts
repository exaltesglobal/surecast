// The unified inbox: comments and replies under every published post, from every network,
// in one list per agency. Replies are sent from Surecast and recorded against the comment,
// so the team can see what was answered, when, and by whom.
import { HttpError, type AuthUser } from '../auth.js';
import { all, one, run } from '../db.js';
import { adapter, PublishError } from '../platforms/index.js';
import { addMs, clip, minutes, newId } from '../util.js';
import { channelCtx, channelFailed, getChannel, type ChannelRow } from './channels.js';
import { replyOnWhatsApp } from './chitthi.js';

const DAY = 86_400_000;
const BATCH = 100;

/** Looks for new comments: every 10 minutes for two days after posting, then hourly for two weeks. */
export async function collectInbox(now = new Date()) {
  const due = await all<{ id: string; post_id: string; workspace_id: string; channel_id: string; remote_id: string; client_id: string }>(
    `SELECT t.id, t.post_id, t.workspace_id, t.channel_id, t.remote_id, p.client_id FROM post_targets t JOIN posts p ON p.id = t.post_id JOIN channels c ON c.id = t.channel_id
     WHERE t.status = 'published' AND t.remote_id IS NOT NULL AND t.remote_id <> '' AND t.published_at >= ? AND c.status <> 'disconnected'
       AND (t.inbox_checked_at IS NULL OR t.inbox_checked_at < CASE WHEN t.published_at >= ? THEN ? ELSE ? END)
     ORDER BY t.inbox_checked_at IS NULL DESC, t.inbox_checked_at LIMIT ${BATCH}`,
    [addMs(now, -14 * DAY), addMs(now, -2 * DAY), addMs(now, -minutes(10)), addMs(now, -minutes(60))],
  );
  const byChannel = new Map<string, typeof due>();
  for (const d of due) byChannel.set(d.channel_id, [...(byChannel.get(d.channel_id) ?? []), d]);
  let found = 0;
  for (const [channelId, targets] of byChannel) {
    const ch = await getChannel(channelId);
    if (!ch) continue;
    const a = adapter(ch.platform);
    let comments: Awaited<ReturnType<NonNullable<typeof a.comments>>> = {};
    if (a.comments) {
      try {
        comments = await a.comments(channelCtx(ch), targets.map((t) => t.remote_id));
      } catch (e) {
        if (!(e instanceof PublishError)) console.error(`Reading comments for channel ${channelId} failed`, e);
        continue;
      }
    }
    for (const t of targets) {
      for (const cm of comments[t.remote_id] ?? []) {
        if (!cm.id) continue;
        const r = await run(
          `INSERT IGNORE INTO inbox_items (id, workspace_id, client_id, channel_id, target_id, post_id, platform, remote_id, parent_remote_id, root_remote_id, author_name, author_handle, author_avatar, body, url, received_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId('inb'),
            t.workspace_id,
            t.client_id,
            channelId,
            t.id,
            t.post_id,
            ch.platform,
            clip(cm.id, 190),
            clip(cm.parentId, 190),
            clip(t.remote_id, 190),
            clip(cm.authorName, 190) ?? '',
            clip(cm.authorHandle, 190) ?? '',
            clip(cm.authorAvatar, 500),
            cm.text.slice(0, 10_000),
            clip(cm.url, 500),
            cm.createdAt,
            now,
          ],
        );
        found += r;
      }
      await run('UPDATE post_targets SET inbox_checked_at = ? WHERE id = ?', [now, t.id]);
    }
  }
  return found;
}

let lastRun = 0;
export async function inboxTick(now = new Date()) {
  if (Date.now() - lastRun < minutes(2)) return;
  lastRun = Date.now();
  await collectInbox(now);
}

export type InboxFilter = { id?: string; clientId?: string; status?: string; platform?: string; limit?: number; before?: string };

export async function listInbox(workspaceId: string, f: InboxFilter) {
  const where = ['i.workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (f.id) where.push('i.id = ?'), params.push(f.id);
  if (f.clientId) where.push('i.client_id = ?'), params.push(f.clientId);
  if (f.status && ['open', 'done'].includes(f.status)) where.push('i.status = ?'), params.push(f.status);
  if (f.platform) where.push('i.platform = ?'), params.push(f.platform);
  if (f.before) where.push('i.received_at < ?'), params.push(new Date(f.before));
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 200);
  const rows = await all(
    `SELECT i.*, COALESCE(c.name, g.account_name, 'WhatsApp') AS channel_name, cl.name AS client_name, LEFT(COALESCE(t.body_override, p.body), 200) AS post_text, t.remote_url AS post_url, u.name AS replied_by_name
     FROM inbox_items i JOIN clients cl ON cl.id = i.client_id
     LEFT JOIN channels c ON c.id = i.channel_id LEFT JOIN integrations g ON g.id = i.channel_id
     LEFT JOIN post_targets t ON t.id = i.target_id LEFT JOIN posts p ON p.id = i.post_id
     LEFT JOIN users u ON u.id = i.replied_by
     WHERE ${where.join(' AND ')} ORDER BY i.received_at DESC LIMIT ${limit}`,
    params,
  );
  const counts = await one<{ open: number }>("SELECT COUNT(*) AS open FROM inbox_items WHERE workspace_id = ? AND status = 'open'", [workspaceId]);
  return { items: rows.map(itemJson), open: Number(counts?.open ?? 0) };
}

function itemJson(r: Record<string, any>) {
  return {
    id: r.id as string,
    clientId: r.client_id,
    clientName: r.client_name,
    channelId: r.channel_id,
    channelName: r.channel_name,
    platform: r.platform,
    postId: r.post_id,
    postText: r.post_text,
    postUrl: r.post_url,
    author: { name: r.author_name, handle: r.author_handle, avatarUrl: r.author_avatar },
    text: r.body as string,
    url: r.url,
    receivedAt: r.received_at,
    status: r.status,
    isReplyToComment: r.platform !== 'whatsapp' && r.parent_remote_id !== r.root_remote_id,
    /** WhatsApp chats are direct messages, not comments under a post. */
    isDirect: r.platform === 'whatsapp',
    reply: r.replied_at ? { text: r.reply_text, at: r.replied_at, by: r.replied_by_name } : null,
    replyError: r.reply_error,
  };
}

export async function getItem(workspaceId: string, id: string) {
  const item = await one('SELECT * FROM inbox_items WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
  if (!item) throw new HttpError(404, 'That message is no longer in the inbox.');
  return item;
}

export async function setStatus(workspaceId: string, ids: string[], status: string) {
  if (!['open', 'done'].includes(status)) throw new HttpError(422, 'Status must be open or done.');
  if (!ids.length) return 0;
  return run('UPDATE inbox_items SET status = ? WHERE workspace_id = ? AND id IN (?)', [status, workspaceId, ids]);
}

/** Sends a reply under a comment and marks it done. */
export async function replyToItem(workspaceId: string, user: AuthUser | null, id: string, text: unknown) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) throw new HttpError(422, 'Write a reply first.');
  const item = await getItem(workspaceId, id);
  if (item.platform === 'whatsapp') {
    if (body.length > 4096) throw new HttpError(422, 'WhatsApp messages can be 4,096 characters at most.');
    try {
      const r = await replyOnWhatsApp(item.channel_id, item.root_remote_id, body);
      await run("UPDATE inbox_items SET status = 'done', reply_text = ?, reply_remote_id = ?, replied_at = ?, replied_by = ?, reply_error = NULL WHERE id = ?", [body, r.remoteId, new Date(), user?.id ?? null, item.id]);
    } catch (e) {
      await run('UPDATE inbox_items SET reply_error = ? WHERE id = ?', [clip((e as Error).message, 1000), item.id]);
      throw e;
    }
    return (await listInbox(workspaceId, { id })).items[0] ?? null;
  }
  const ch = (await getChannel(item.channel_id)) as ChannelRow | null;
  if (!ch) throw new HttpError(409, 'The channel for this comment was removed.');
  const a = adapter(ch.platform);
  const limit = a.limits.maxChars;
  if (a.count(body) > limit) throw new HttpError(422, `${a.label} replies can be ${limit} characters at most.`);
  if (!a.answer && !a.reply) throw new HttpError(422, `${a.label} does not allow replies from Surecast.`);
  try {
    const key = `inbox-${item.id}`;
    const r = a.answer
      ? await a.answer(channelCtx(ch), { id: item.remote_id, rootId: item.root_remote_id }, body, key)
      : await a.reply!(channelCtx(ch), { parentId: item.remote_id, rootId: item.root_remote_id }, body, key);
    await run("UPDATE inbox_items SET status = 'done', reply_text = ?, reply_remote_id = ?, replied_at = ?, replied_by = ?, reply_error = NULL WHERE id = ?", [
      body,
      clip(r.remoteId, 190),
      new Date(),
      user?.id ?? null,
      item.id,
    ]);
  } catch (e) {
    if (!(e instanceof PublishError)) throw e;
    if (e.kind === 'auth') await channelFailed(ch, e);
    await run('UPDATE inbox_items SET reply_error = ? WHERE id = ?', [clip(`${e.message}. ${e.hint}`, 1000), item.id]);
    throw new HttpError(502, `${a.label} did not accept the reply: ${e.message}. ${e.hint}`);
  }
  return (await listInbox(workspaceId, { id })).items[0] ?? null;
}
