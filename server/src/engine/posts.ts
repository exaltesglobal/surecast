// Creating, editing, approving, retrying and cancelling posts.
import { HttpError, type AuthUser } from '../auth.js';
import { config } from '../config.js';
import { all, json, one, run, type Row } from '../db.js';
import { emailHtml, sendEmail } from '../mail.js';
import { adapter } from '../platforms/index.js';
import { newId } from '../util.js';
import { raiseAlert, resolveAlerts } from './alerts.js';
import { contentIssues, mediaMeta, mediaUrl } from './content.js';
import { rollupPost } from './publisher.js';

export type PostInput = {
  clientId?: unknown;
  body?: unknown;
  mediaIds?: unknown;
  channelIds?: unknown;
  overrides?: unknown;
  scheduledAt?: unknown;
  action?: unknown;
};

type ClientRow = Row & { id: string; name: string; approval_required: number; contact_email: string | null; share_token: string; timezone: string };

const strArray = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export async function getClient(workspaceId: string, clientId: unknown) {
  if (typeof clientId !== 'string') throw new HttpError(422, 'Choose a client.');
  const client = await one<ClientRow>('SELECT * FROM clients WHERE id = ? AND workspace_id = ?', [clientId, workspaceId]);
  if (!client) throw new HttpError(404, 'Client not found.');
  return client;
}

/** Problems per channel for the composer, using each platform's own rules. */
export async function validateDraft(workspaceId: string, input: PostInput) {
  const channelIds = strArray(input.channelIds);
  const overrides = (input.overrides && typeof input.overrides === 'object' ? input.overrides : {}) as Record<string, string>;
  const body = typeof input.body === 'string' ? input.body : '';
  const media = await mediaMeta(strArray(input.mediaIds));
  const channels = channelIds.length ? await all<{ id: string; platform: string; name: string }>('SELECT id, platform, name FROM channels WHERE id IN (?) AND workspace_id = ?', [channelIds, workspaceId]) : [];
  return channels.map((ch) => {
    const a = adapter(ch.platform);
    const text = typeof overrides[ch.id] === 'string' ? overrides[ch.id] : body;
    return { channelId: ch.id, platform: ch.platform, count: a.count(text), max: ch.platform === 'telegram' && media.length ? 1024 : a.limits.maxChars, issues: contentIssues(a, text, media) };
  });
}

export async function savePost(workspaceId: string, user: AuthUser | null, input: PostInput, postId?: string, source = 'app') {
  const action = input.action === 'now' || input.action === 'schedule' ? input.action : 'draft';
  const existing = postId ? await one<Row>('SELECT * FROM posts WHERE id = ? AND workspace_id = ?', [postId, workspaceId]) : null;
  if (postId && !existing) throw new HttpError(404, 'Post not found.');
  const client = await getClient(workspaceId, existing?.client_id ?? input.clientId);
  const body = typeof input.body === 'string' ? input.body.slice(0, 65_000) : '';
  const mediaIds = strArray(input.mediaIds).slice(0, 10);
  if (mediaIds.length) {
    const owned = await all('SELECT id FROM media WHERE id IN (?) AND workspace_id = ?', [mediaIds, workspaceId]);
    if (owned.length !== new Set(mediaIds).size) throw new HttpError(422, 'One of the images was not found.');
  }
  const channelIds = [...new Set(strArray(input.channelIds))];
  if (action !== 'draft' && !channelIds.length) throw new HttpError(422, 'Choose at least one channel.');
  if (channelIds.length) {
    const owned = await all<{ id: string }>('SELECT id FROM channels WHERE id IN (?) AND client_id = ?', [channelIds, client.id]);
    if (owned.length !== channelIds.length) throw new HttpError(422, "Some channels do not belong to this client.");
  }
  const overrides = (input.overrides && typeof input.overrides === 'object' ? input.overrides : {}) as Record<string, unknown>;

  const now = new Date();
  let scheduledAt: Date | null = null;
  if (action === 'now') scheduledAt = now;
  else if (typeof input.scheduledAt === 'string' && input.scheduledAt) {
    scheduledAt = new Date(input.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) throw new HttpError(422, 'That date is not valid.');
  }
  if (action === 'schedule') {
    if (!scheduledAt) throw new HttpError(422, 'Pick a date and time.');
    if (scheduledAt.getTime() < now.getTime() - 60_000) throw new HttpError(422, 'That time has already passed. Pick a time in the future or post now.');
  }

  if (action !== 'draft') {
    const report = await validateDraft(workspaceId, { body, mediaIds, channelIds, overrides });
    const problems = report.filter((r) => r.issues.length);
    if (problems.length) throw Object.assign(new HttpError(422, 'Some channels cannot take this post as it is.'), { details: problems });
  }

  const contentChanged = !existing || existing.body !== body || JSON.stringify(json(existing.media_ids, [])) !== JSON.stringify(mediaIds) || Object.keys(overrides).length > 0;
  let approval = existing?.approval_status ?? 'not_needed';
  if (!client.approval_required) approval = 'not_needed';
  else if (action !== 'draft' && (approval !== 'approved' || contentChanged)) approval = 'pending';
  const targetStatus = action === 'draft' ? 'draft' : approval === 'pending' ? 'awaiting_approval' : 'scheduled';

  const id = existing?.id ?? newId('pst');
  if (existing) {
    await run('UPDATE posts SET body = ?, media_ids = ?, scheduled_at = ?, approval_status = ?, updated_at = ? WHERE id = ?', [body, JSON.stringify(mediaIds), scheduledAt, approval, now, id]);
  } else {
    await run('INSERT INTO posts (id, workspace_id, client_id, author_id, status, body, media_ids, scheduled_at, approval_status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      id,
      workspaceId,
      client.id,
      user?.id ?? null,
      targetStatus,
      body,
      JSON.stringify(mediaIds),
      scheduledAt,
      approval,
      source,
      now,
      now,
    ]);
  }

  // Targets that already went out (or are going out right now) are left exactly as they are.
  const targets = await all<{ id: string; channel_id: string; status: string }>('SELECT id, channel_id, status FROM post_targets WHERE post_id = ?', [id]);
  const locked = new Set(targets.filter((t) => t.status === 'published' || t.status === 'publishing').map((t) => t.channel_id));
  for (const t of targets) if (!locked.has(t.channel_id) && !channelIds.includes(t.channel_id)) await run('DELETE FROM post_targets WHERE id = ?', [t.id]);
  for (const chId of channelIds) {
    if (locked.has(chId)) continue;
    const override = typeof overrides[chId] === 'string' && overrides[chId] !== body ? (overrides[chId] as string) : null;
    const t = targets.find((x) => x.channel_id === chId);
    if (t)
      await run(
        'UPDATE post_targets SET body_override = ?, status = ?, due_at = ?, next_attempt_at = ?, attempts = 0, preflight_at = NULL, preflight_ok = NULL, preflight_message = NULL, error_code = NULL, error_message = NULL, error_hint = NULL, updated_at = ? WHERE id = ?',
        [override, targetStatus, scheduledAt, scheduledAt, now, t.id],
      );
    else
      await run('INSERT INTO post_targets (id, post_id, workspace_id, channel_id, body_override, status, due_at, next_attempt_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        newId('tgt'),
        id,
        workspaceId,
        chId,
        override,
        targetStatus,
        scheduledAt,
        scheduledAt,
        now,
      ]);
  }
  await resolveAlerts(workspaceId, targets.flatMap((t) => [`target:${t.id}:failed`, `target:${t.id}:preflight`, `target:${t.id}:waiting`]));
  await rollupPost(id);

  if (approval === 'pending' && (existing?.approval_status !== 'pending' || contentChanged)) await requestApproval(client, id, user);
  return id;
}

async function requestApproval(client: ClientRow, postId: string, user: AuthUser | null) {
  await run('INSERT INTO post_comments (id, post_id, author_name, from_client, kind, body, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)', [
    newId('cmt'),
    postId,
    user?.name || user?.email || 'Surecast',
    'approval_requested',
    'Sent for client approval.',
    new Date(),
  ]);
  if (!client.contact_email) return;
  const url = `${config.publicUrl}/c/${client.share_token}`;
  await sendEmail(
    client.contact_email,
    `A post is ready for your approval`,
    `Hello,\n\nA new post for ${client.name} is ready for you to review. Approve it or ask for changes here:\n${url}\n\nNo account needed.`,
    emailHtml('A post is ready for your approval', [`A new post for ${client.name} is waiting for your review.`, 'Approve it or ask for changes. No account needed.'], { label: 'Review posts', url }),
  ).catch((e) => console.error('Approval email failed', e));
}

export async function decideApproval(postId: string, clientId: string, decision: 'approved' | 'changes_requested', name: string, comment: string) {
  const post = await one<Row>('SELECT * FROM posts WHERE id = ? AND client_id = ?', [postId, clientId]);
  if (!post) throw new HttpError(404, 'Post not found.');
  if (post.approval_status !== 'pending' && post.approval_status !== 'changes_requested') throw new HttpError(409, 'This post is not waiting for approval.');
  const now = new Date();
  await run('UPDATE posts SET approval_status = ?, updated_at = ? WHERE id = ?', [decision, now, postId]);
  await run('INSERT INTO post_comments (id, post_id, author_name, from_client, kind, body, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)', [
    newId('cmt'),
    postId,
    name.slice(0, 120) || 'Client',
    decision,
    comment.slice(0, 5000) || (decision === 'approved' ? 'Approved.' : 'Changes requested.'),
    now,
  ]);
  if (decision === 'approved') {
    await run("UPDATE post_targets SET status = 'scheduled', updated_at = ? WHERE post_id = ? AND status = 'awaiting_approval'", [now, postId]);
    await resolveAlerts(post.workspace_id, [`post:${postId}:changes`]);
  } else {
    const client = await one<{ name: string }>('SELECT name FROM clients WHERE id = ?', [clientId]);
    await raiseAlert({
      workspaceId: post.workspace_id,
      key: `post:${postId}:changes`,
      kind: 'changes_requested',
      severity: 'warning',
      title: `${client?.name ?? 'A client'} asked for changes to a post`,
      detail: comment.slice(0, 900) || undefined,
      clientId,
      postId,
    });
  }
  await rollupPost(postId);
}

export async function retryPost(workspaceId: string, postId: string, targetId?: string) {
  const now = new Date();
  const n = await run(
    `UPDATE post_targets SET status = 'scheduled', attempts = 0, due_at = ?, next_attempt_at = ?, preflight_at = NULL, error_code = NULL, error_message = NULL, error_hint = NULL, updated_at = ?
     WHERE post_id = ? AND workspace_id = ? AND status = 'failed'${targetId ? ' AND id = ?' : ''}`,
    [now, now, now, postId, workspaceId, ...(targetId ? [targetId] : [])],
  );
  if (!n) throw new HttpError(409, 'Nothing to retry: no failed channels on this post.');
  const ids = await all<{ id: string }>('SELECT id FROM post_targets WHERE post_id = ?', [postId]);
  await resolveAlerts(workspaceId, ids.flatMap((t) => [`target:${t.id}:failed`]));
  await rollupPost(postId);
}

export async function cancelPost(workspaceId: string, postId: string) {
  const n = await run(
    "UPDATE post_targets SET status = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE post_id = ? AND workspace_id = ? AND status IN ('draft', 'awaiting_approval', 'scheduled', 'retrying')",
    [new Date(), postId, workspaceId],
  );
  if (!n) throw new HttpError(409, 'Nothing left to cancel on this post.');
  const ids = await all<{ id: string }>('SELECT id FROM post_targets WHERE post_id = ?', [postId]);
  await resolveAlerts(workspaceId, ids.flatMap((t) => [`target:${t.id}:failed`, `target:${t.id}:preflight`, `target:${t.id}:waiting`]));
  await rollupPost(postId);
}

/** The shape the web app and API see. */
export async function postsJson(posts: Row[], opts: { attempts?: boolean; comments?: boolean } = {}) {
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const targets = await all(
    `SELECT t.*, c.platform, c.name AS channel_name, c.handle AS channel_handle, c.avatar_url AS channel_avatar, c.status AS channel_status
     FROM post_targets t LEFT JOIN channels c ON c.id = t.channel_id WHERE t.post_id IN (?) ORDER BY c.platform`,
    [ids],
  );
  const attempts = opts.attempts && targets.length ? await all('SELECT * FROM attempts WHERE target_id IN (?) ORDER BY started_at', [targets.map((t) => t.id)]) : [];
  const comments = opts.comments ? await all('SELECT * FROM post_comments WHERE post_id IN (?) ORDER BY created_at', [ids]) : [];
  const allMedia = await mediaMeta([...new Set(posts.flatMap((p) => json<string[]>(p.media_ids, [])))]);
  return posts.map((p) => ({
    id: p.id,
    clientId: p.client_id,
    status: p.status,
    approvalStatus: p.approval_status,
    body: p.body,
    source: p.source,
    scheduledAt: p.scheduled_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    media: json<string[]>(p.media_ids, [])
      .map((id) => allMedia.find((m) => m.id === id))
      .filter(Boolean)
      .map((m) => ({ id: m!.id, url: mediaUrl(m!.public_key), mime: m!.mime, alt: m!.alt, filename: m!.filename, size: m!.size })),
    targets: targets
      .filter((t) => t.post_id === p.id)
      .map((t) => ({
        id: t.id,
        channelId: t.channel_id,
        platform: t.platform,
        channelName: t.channel_name,
        channelHandle: t.channel_handle,
        channelAvatar: t.channel_avatar,
        channelStatus: t.channel_status,
        body: t.body_override,
        status: t.status,
        dueAt: t.due_at,
        nextAttemptAt: t.next_attempt_at,
        attempts: t.attempts,
        preflightOk: t.preflight_ok == null ? null : !!t.preflight_ok,
        preflightMessage: t.preflight_message,
        publishedAt: t.published_at,
        remoteUrl: t.remote_url,
        error: t.error_code ? { code: t.error_code, message: t.error_message, hint: t.error_hint } : null,
        ...(opts.attempts
          ? {
              log: attempts
                .filter((a) => a.target_id === t.id)
                .map((a) => ({ number: a.number, startedAt: a.started_at, finishedAt: a.finished_at, outcome: a.outcome, code: a.error_code, httpStatus: a.http_status, message: a.message })),
            }
          : {}),
      })),
    ...(opts.comments
      ? { comments: comments.filter((c) => c.post_id === p.id).map((c) => ({ id: c.id, author: c.author_name, fromClient: !!c.from_client, kind: c.kind, body: c.body, createdAt: c.created_at })) }
      : {}),
  }));
}
