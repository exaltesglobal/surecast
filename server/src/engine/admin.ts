// The Surecast team's admin panel: every workspace, user and post across the whole service.
// Staff roles decide what each person can do; ADMIN_EMAILS are always superadmins. Every change
// a staff member makes is written to the audit log, with who, what, when and from where.
import { HttpError, type AuthUser } from '../auth.js';
import { config } from '../config.js';
import { all, one, run } from '../db.js';
import { addMs, clip, isEmail, newId } from '../util.js';
import { pauseClient, resumeClient } from './brake.js';
import { lastTick } from './publisher.js';

export const STAFF_ROLES = ['superadmin', 'admin', 'support', 'success', 'analyst'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** What each role can do. Everyone on staff can look; changes need the matching permission. */
export const PERMISSIONS = {
  'workspaces.manage': ['superadmin', 'admin', 'success'],
  'workspaces.suspend': ['superadmin', 'admin'],
  'workspaces.delete': ['superadmin'],
  impersonate: ['superadmin', 'admin', 'support'],
  'publishing.ops': ['superadmin', 'admin', 'support'],
  announcements: ['superadmin', 'admin', 'success'],
  staff: ['superadmin'],
  audit: ['superadmin', 'admin'],
} as const satisfies Record<string, readonly StaffRole[]>;
export type Permission = keyof typeof PERMISSIONS;

export const ROLE_INFO: Record<StaffRole, string> = {
  superadmin: 'Everything, including deleting workspaces and managing staff.',
  admin: 'Runs the service: plans, suspensions, impersonation, publishing fixes and the audit log.',
  support: 'Helps customers: can view as a customer and fix stuck posts.',
  success: 'Looks after accounts: plans, trials, notes and announcements.',
  analyst: 'Read-only access to every page.',
};

export const PLANS: Record<string, { label: string; clients: number | null; priceInr: number | null }> = {
  trial: { label: 'Trial', clients: 50, priceInr: null },
  solo: { label: 'Solo', clients: 10, priceInr: 799 },
  agency: { label: 'Agency', clients: 50, priceInr: 2499 },
  scale: { label: 'Scale', clients: 200, priceInr: 5999 },
  comp: { label: 'Complimentary', clients: null, priceInr: null },
};

export async function staffRole(user: AuthUser | null): Promise<StaffRole | null> {
  if (!user) return null;
  if (config.adminEmails.includes(user.email.toLowerCase())) return 'superadmin';
  const s = await one<{ role: StaffRole }>('SELECT role FROM staff WHERE user_id = ?', [user.id]);
  return s && STAFF_ROLES.includes(s.role) ? s.role : null;
}

export const can = (role: StaffRole | null, p: Permission) => !!role && (PERMISSIONS[p] as readonly string[]).includes(role);
export const permissionsOf = (role: StaffRole) => (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));

export async function audit(actor: AuthUser, action: string, opts: { workspaceId?: string | null; target?: string | null; detail?: unknown; ip?: string | null } = {}) {
  await run('INSERT INTO audit_log (actor_id, actor_email, action, workspace_id, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    actor.id,
    actor.email,
    action,
    opts.workspaceId ?? null,
    clip(opts.target ?? null, 190),
    opts.detail === undefined ? null : clip(typeof opts.detail === 'string' ? opts.detail : JSON.stringify(opts.detail), 5000),
    clip(opts.ip ?? null, 64),
    new Date(),
  ]);
}

const DAY = 86_400_000;
const n = (v: unknown) => Number(v ?? 0);

/** The numbers on the admin home page. */
export async function overview(now = new Date()) {
  const d1 = addMs(now, -DAY);
  const d7 = addMs(now, -7 * DAY);
  const d30 = addMs(now, -30 * DAY);
  const [ws, users, plans, posts, targets7, failing, channels, ai, signups, tick, trials] = await Promise.all([
    one('SELECT COUNT(*) AS total, SUM(suspended_at IS NOT NULL) AS suspended, SUM(created_at >= ?) AS new7 FROM workspaces', [d7]),
    one('SELECT COUNT(*) AS total, SUM(created_at >= ?) AS new7, (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE created_at >= ?) AS active7 FROM users', [d7, d7]),
    all<{ plan: string; count: number }>('SELECT plan, COUNT(*) AS count FROM workspaces GROUP BY plan'),
    one(
      "SELECT SUM(status = 'scheduled') AS scheduled, SUM(status = 'awaiting_approval') AS awaiting, SUM(status = 'paused') AS paused, COUNT(*) AS total FROM posts",
    ),
    one(
      "SELECT SUM(status = 'published' AND published_at >= ?) AS published24, SUM(status = 'published' AND published_at >= ?) AS published7, SUM(status = 'failed' AND updated_at >= ?) AS failed7 FROM post_targets",
      [d1, d7, d7],
    ),
    one("SELECT COUNT(*) AS stuck FROM post_targets WHERE status IN ('scheduled', 'retrying') AND next_attempt_at < ?", [addMs(now, -15 * 60_000)]),
    one("SELECT COUNT(*) AS total, SUM(status = 'disconnected') AS disconnected, SUM(status = 'warning') AS warning FROM channels"),
    one('SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output FROM ai_usage WHERE day >= ?', [d7.toISOString().slice(0, 10)]),
    all<{ day: string; count: number }>("SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS count FROM workspaces WHERE created_at >= ? GROUP BY day ORDER BY day", [d30]),
    lastTick(),
    all("SELECT id, name, trial_ends_at FROM workspaces WHERE plan = 'trial' AND suspended_at IS NULL AND trial_ends_at BETWEEN ? AND ? ORDER BY trial_ends_at LIMIT 10", [now, addMs(now, 3 * DAY)]),
  ]);
  const published7 = n(targets7?.published7);
  const failed7 = n(targets7?.failed7);
  return {
    workspaces: { total: n(ws?.total), suspended: n(ws?.suspended), new7: n(ws?.new7), byPlan: Object.fromEntries(plans.map((p) => [p.plan, n(p.count)])) },
    users: { total: n(users?.total), new7: n(users?.new7), active7: n(users?.active7) },
    publishing: {
      published24: n(targets7?.published24),
      published7,
      failed7,
      successRate7: published7 + failed7 ? Math.round((published7 / (published7 + failed7)) * 1000) / 10 : null,
      scheduled: n(posts?.scheduled),
      awaitingApproval: n(posts?.awaiting),
      paused: n(posts?.paused),
      stuck: n(failing?.stuck),
    },
    channels: { total: n(channels?.total), disconnected: n(channels?.disconnected), warning: n(channels?.warning) },
    ai: { requests7: n(ai?.requests), inputTokens7: n(ai?.input), outputTokens7: n(ai?.output) },
    signups: signups.map((s) => ({ day: s.day, count: n(s.count) })),
    trialsEnding: trials.map((t) => ({ id: t.id, name: t.name, trialEndsAt: t.trial_ends_at })),
    scheduler: tick ? { lastTickAt: tick.last_tick_at, source: tick.last_source, healthy: now.getTime() - tick.last_tick_at.getTime() < 3 * 60_000 } : null,
  };
}

const wsRow = (w: Record<string, any>) => ({
  id: w.id,
  name: w.name,
  plan: w.plan,
  planLabel: PLANS[w.plan]?.label ?? w.plan,
  trialEndsAt: w.trial_ends_at,
  suspended: w.suspended_at ? { at: w.suspended_at, reason: w.suspended_reason } : null,
  createdAt: w.created_at,
  owner: w.owner_email ?? null,
  members: n(w.members),
  clients: n(w.clients),
  channels: n(w.channels),
  failed7: n(w.failed7),
  lastActiveAt: w.last_active ?? null,
});

export async function listWorkspaces(q: { search?: string; plan?: string; status?: string; limit?: number; offset?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.search) {
    where.push('(w.name LIKE ? OR w.id = ? OR EXISTS (SELECT 1 FROM members m2 JOIN users u2 ON u2.id = m2.user_id WHERE m2.workspace_id = w.id AND u2.email LIKE ?))');
    params.push(`%${q.search}%`, q.search, `%${q.search}%`);
  }
  if (q.plan && PLANS[q.plan]) where.push('w.plan = ?'), params.push(q.plan);
  if (q.status === 'suspended') where.push('w.suspended_at IS NOT NULL');
  if (q.status === 'active') where.push('w.suspended_at IS NULL');
  if (q.status === 'trial_expired') where.push("w.plan = 'trial' AND w.trial_ends_at < ?"), params.push(new Date());
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);
  const rows = await all(
    `SELECT w.*,
       (SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = w.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_email,
       (SELECT COUNT(*) FROM members m WHERE m.workspace_id = w.id) AS members,
       (SELECT COUNT(*) FROM clients c WHERE c.workspace_id = w.id AND c.archived_at IS NULL) AS clients,
       (SELECT COUNT(*) FROM channels ch WHERE ch.workspace_id = w.id) AS channels,
       (SELECT COUNT(*) FROM post_targets t WHERE t.workspace_id = w.id AND t.status = 'failed' AND t.updated_at >= ?) AS failed7,
       (SELECT MAX(s.created_at) FROM sessions s JOIN members m ON m.user_id = s.user_id WHERE m.workspace_id = w.id AND s.impersonated_by IS NULL) AS last_active
     FROM workspaces w ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY w.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    [addMs(new Date(), -7 * DAY), ...params],
  );
  const total = await one(`SELECT COUNT(*) AS n FROM workspaces w ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, params);
  return { workspaces: rows.map(wsRow), total: n(total?.n) };
}

export async function workspaceDetail(id: string) {
  const w = (await listWorkspaces({ search: id, limit: 1 })).workspaces.find((x) => x.id === id);
  if (!w) throw new HttpError(404, 'Workspace not found.');
  const row = await one('SELECT staff_notes, timezone FROM workspaces WHERE id = ?', [id]);
  const [members, clients, channels, failures, usage] = await Promise.all([
    all("SELECT u.id, u.email, u.name, m.role, m.created_at AS joinedAt FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY FIELD(m.role, 'owner', 'admin', 'editor'), m.created_at", [id]),
    all('SELECT id, name, timezone, paused_at AS pausedAt, paused_reason AS pausedReason, archived_at AS archivedAt, approval_required AS approvalRequired FROM clients WHERE workspace_id = ? ORDER BY name', [id]),
    all('SELECT id, client_id AS clientId, platform, name, handle, status, status_message AS statusMessage, last_checked_at AS lastCheckedAt FROM channels WHERE workspace_id = ? ORDER BY platform, name', [id]),
    all(
      `SELECT t.id, t.post_id AS postId, t.error_code AS code, t.error_message AS message, t.updated_at AS at, ch.platform, ch.name AS channel
       FROM post_targets t LEFT JOIN channels ch ON ch.id = t.channel_id WHERE t.workspace_id = ? AND t.status = 'failed' ORDER BY t.updated_at DESC LIMIT 20`,
      [id],
    ),
    one('SELECT COALESCE(SUM(requests), 0) AS requests FROM ai_usage WHERE workspace_id = ? AND day >= ?', [id, addMs(new Date(), -30 * DAY).toISOString().slice(0, 10)]),
  ]);
  const audits = await all('SELECT id, actor_email AS actor, action, target, detail, created_at AS at FROM audit_log WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 30', [id]);
  return {
    workspace: { ...w, timezone: row?.timezone, staffNotes: row?.staff_notes ?? '', clientLimit: PLANS[w.plan]?.clients ?? null, aiRequests30: n(usage?.requests) },
    members,
    clients: clients.map((c) => ({ ...c, approvalRequired: !!c.approvalRequired })),
    channels,
    failures,
    audit: audits,
  };
}

export async function updateWorkspace(id: string, b: Record<string, unknown>) {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (b.plan !== undefined) {
    if (typeof b.plan !== 'string' || !PLANS[b.plan]) throw new HttpError(422, 'Unknown plan.');
    sets.push('plan = ?'), params.push(b.plan);
  }
  if (b.trialEndsAt !== undefined) {
    const d = b.trialEndsAt ? new Date(String(b.trialEndsAt)) : null;
    if (d && Number.isNaN(d.getTime())) throw new HttpError(422, 'That trial end date is not valid.');
    sets.push('trial_ends_at = ?'), params.push(d);
  }
  if (b.extendTrialDays !== undefined) {
    const days = Math.round(Number(b.extendTrialDays));
    if (!Number.isFinite(days) || days < 1 || days > 365) throw new HttpError(422, 'Extend the trial by 1 to 365 days.');
    sets.push(`trial_ends_at = DATE_ADD(GREATEST(COALESCE(trial_ends_at, ?), ?), INTERVAL ${days} DAY)`), params.push(new Date(), new Date());
  }
  if (b.staffNotes !== undefined) sets.push('staff_notes = ?'), params.push(typeof b.staffNotes === 'string' ? b.staffNotes.slice(0, 10_000) : null);
  if (!sets.length) throw new HttpError(422, 'Nothing to change.');
  const changed = await run(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  if (!changed) throw new HttpError(404, 'Workspace not found.');
}

/** Suspension stops all publishing (every client is paused) and makes the workspace read-only. */
export async function suspendWorkspace(id: string, reason: string, actor: AuthUser) {
  const w = await one('SELECT id, suspended_at FROM workspaces WHERE id = ?', [id]);
  if (!w) throw new HttpError(404, 'Workspace not found.');
  if (w.suspended_at) throw new HttpError(409, 'This workspace is already suspended.');
  if (!reason.trim()) throw new HttpError(422, 'Give a reason. The team and the customer will see it.');
  await run('UPDATE workspaces SET suspended_at = ?, suspended_reason = ? WHERE id = ?', [new Date(), reason.trim().slice(0, 500), id]);
  const clients = await all<{ id: string }>('SELECT id FROM clients WHERE workspace_id = ? AND paused_at IS NULL', [id]);
  let held = 0;
  for (const c of clients) held += (await pauseClient(id, c.id, { reason: `Workspace suspended: ${reason}`, missed: 'skip', by: 'suspension' }, actor)).held;
  return { held };
}

export async function unsuspendWorkspace(id: string, actor: AuthUser) {
  const changed = await run('UPDATE workspaces SET suspended_at = NULL, suspended_reason = NULL WHERE id = ? AND suspended_at IS NOT NULL', [id]);
  if (!changed) throw new HttpError(409, 'This workspace is not suspended.');
  // Only clients the suspension paused come back; ones the agency paused itself stay paused.
  const clients = await all<{ id: string }>("SELECT id FROM clients WHERE workspace_id = ? AND paused_at IS NOT NULL AND paused_by = 'suspension'", [id]);
  const totals = { resumed: 0, skipped: 0 };
  for (const c of clients) {
    const r = await resumeClient(id, c.id, 'skip', actor);
    totals.resumed += r.resumed;
    totals.skipped += r.skipped;
  }
  return totals;
}

/** Deletes a workspace and everything in it. Users stay (they may belong to other workspaces). */
export async function deleteWorkspace(id: string, confirmName: unknown) {
  const w = await one<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [id]);
  if (!w) throw new HttpError(404, 'Workspace not found.');
  if (typeof confirmName !== 'string' || confirmName.trim() !== w.name) throw new HttpError(422, 'Type the workspace name exactly to confirm.');
  const targets = (await all<{ id: string }>('SELECT id FROM post_targets WHERE workspace_id = ?', [id])).map((r) => r.id);
  const posts = (await all<{ id: string }>('SELECT id FROM posts WHERE workspace_id = ?', [id])).map((r) => r.id);
  const clients = (await all<{ id: string }>('SELECT id FROM clients WHERE workspace_id = ?', [id])).map((r) => r.id);
  const channels = (await all<{ id: string }>('SELECT id FROM channels WHERE workspace_id = ?', [id])).map((r) => r.id);
  if (targets.length) await run('DELETE FROM attempts WHERE target_id IN (?)', [targets]);
  if (posts.length) await run('DELETE FROM post_comments WHERE post_id IN (?)', [posts]);
  if (clients.length) await run('DELETE FROM link_clicks WHERE client_id IN (?)', [clients]);
  if (channels.length) await run('DELETE FROM channel_stats WHERE channel_id IN (?)', [channels]);
  await run('DELETE mc FROM media_chunks mc JOIN media m ON m.id = mc.media_id WHERE m.workspace_id = ?', [id]);
  // Every other table that belongs to a workspace has a workspace_id column.
  const tables = await all<{ t: string }>("SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'workspace_id' AND TABLE_NAME NOT IN ('audit_log', 'workspaces')");
  for (const { t } of tables) await run(`DELETE FROM \`${t}\` WHERE workspace_id = ?`, [id]);
  await run('DELETE FROM workspaces WHERE id = ?', [id]);
  return { name: w.name, posts: posts.length, clients: clients.length };
}

export async function listUsers(q: { search?: string; limit?: number }) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const rows = await all(
    `SELECT u.id, u.email, u.name, u.created_at AS createdAt, s.role AS staffRole,
       (SELECT MAX(x.created_at) FROM sessions x WHERE x.user_id = u.id AND x.impersonated_by IS NULL) AS lastSignInAt,
       (SELECT GROUP_CONCAT(CONCAT(w.name, ' (', m.role, ')') SEPARATOR ', ') FROM members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = u.id) AS workspaces
     FROM users u LEFT JOIN staff s ON s.user_id = u.id
     ${q.search ? 'WHERE u.email LIKE ? OR u.name LIKE ? OR u.id = ?' : ''} ORDER BY u.created_at DESC LIMIT ${limit}`,
    q.search ? [`%${q.search}%`, `%${q.search}%`, q.search] : [],
  );
  return { users: rows.map((r) => ({ ...r, staffRole: config.adminEmails.includes(String(r.email).toLowerCase()) ? 'superadmin' : r.staffRole ?? null })) };
}

/** Publishing health across the service: where posts fail and why. */
export async function health(now = new Date()) {
  const d7 = addMs(now, -7 * DAY);
  const [byPlatform, byError, stuck, disconnected, tick] = await Promise.all([
    all(
      `SELECT ch.platform, SUM(t.status = 'published') AS published, SUM(t.status = 'failed') AS failed
       FROM post_targets t JOIN channels ch ON ch.id = t.channel_id WHERE t.updated_at >= ? AND t.status IN ('published', 'failed') GROUP BY ch.platform ORDER BY failed DESC`,
      [d7],
    ),
    all("SELECT error_code AS code, COUNT(*) AS count, MAX(error_message) AS example FROM post_targets WHERE status = 'failed' AND updated_at >= ? GROUP BY error_code ORDER BY count DESC LIMIT 15", [d7]),
    all(
      `SELECT t.id, t.post_id AS postId, t.workspace_id AS workspaceId, w.name AS workspace, t.status, t.next_attempt_at AS nextAttemptAt, t.error_code AS code
       FROM post_targets t JOIN workspaces w ON w.id = t.workspace_id WHERE t.status IN ('scheduled', 'retrying', 'publishing') AND t.next_attempt_at < ? ORDER BY t.next_attempt_at LIMIT 50`,
      [addMs(now, -15 * 60_000)],
    ),
    all(
      `SELECT ch.id, ch.platform, ch.name, ch.status_message AS message, ch.workspace_id AS workspaceId, w.name AS workspace, ch.last_checked_at AS lastCheckedAt
       FROM channels ch JOIN workspaces w ON w.id = ch.workspace_id WHERE ch.status = 'disconnected' ORDER BY ch.last_checked_at DESC LIMIT 50`,
    ),
    lastTick(),
  ]);
  return {
    platforms: byPlatform.map((p) => {
      const ok = n(p.published);
      const bad = n(p.failed);
      return { platform: p.platform, published: ok, failed: bad, successRate: ok + bad ? Math.round((ok / (ok + bad)) * 1000) / 10 : null };
    }),
    errors: byError.map((e) => ({ code: e.code ?? 'unknown', count: n(e.count), example: e.example })),
    stuck,
    disconnected,
    scheduler: tick ? { lastTickAt: tick.last_tick_at, source: tick.last_source, healthy: now.getTime() - tick.last_tick_at.getTime() < 3 * 60_000 } : null,
  };
}

// ---------------------------------------------------------------- announcements

const LEVELS = ['info', 'success', 'warning', 'critical'];

function cleanAnnouncement(b: Record<string, unknown>) {
  const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
  if (!title) throw new HttpError(422, 'Give the announcement a title.');
  const startsAt = b.startsAt ? new Date(String(b.startsAt)) : new Date();
  const endsAt = b.endsAt ? new Date(String(b.endsAt)) : null;
  if (Number.isNaN(startsAt.getTime()) || (endsAt && Number.isNaN(endsAt.getTime()))) throw new HttpError(422, 'Check the dates.');
  if (endsAt && endsAt <= startsAt) throw new HttpError(422, 'The end has to be after the start.');
  return { title, body: typeof b.body === 'string' ? b.body.trim().slice(0, 1000) : '', level: LEVELS.includes(String(b.level)) ? String(b.level) : 'info', startsAt, endsAt };
}

export async function listAnnouncements() {
  return all('SELECT id, title, body, level, starts_at AS startsAt, ends_at AS endsAt, created_at AS createdAt FROM announcements ORDER BY starts_at DESC LIMIT 100');
}

/** The banners signed-in customers see right now. */
export async function activeAnnouncements(now = new Date()) {
  return all('SELECT id, title, body, level FROM announcements WHERE starts_at <= ? AND (ends_at IS NULL OR ends_at > ?) ORDER BY starts_at DESC LIMIT 3', [now, now]);
}

export async function saveAnnouncement(b: Record<string, unknown>, actor: AuthUser, id?: string) {
  const a = cleanAnnouncement(b);
  if (id) {
    const changed = await run('UPDATE announcements SET title = ?, body = ?, level = ?, starts_at = ?, ends_at = ? WHERE id = ?', [a.title, a.body, a.level, a.startsAt, a.endsAt, id]);
    if (!changed) throw new HttpError(404, 'Announcement not found.');
    return id;
  }
  const newIdValue = newId('ann');
  await run('INSERT INTO announcements (id, title, body, level, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    newIdValue,
    a.title,
    a.body,
    a.level,
    a.startsAt,
    a.endsAt,
    actor.id,
    new Date(),
  ]);
  return newIdValue;
}

// ---------------------------------------------------------------- staff

export async function listStaff() {
  const rows = await all<{ id: string; email: string; name: string; role: string; createdAt: Date }>(
    'SELECT u.id, u.email, u.name, s.role, s.created_at AS createdAt FROM staff s JOIN users u ON u.id = s.user_id ORDER BY s.created_at',
  );
  const fixed = config.adminEmails.filter((e) => !rows.some((r) => r.email.toLowerCase() === e)).map((email) => ({ id: null, email, name: '', role: 'superadmin', createdAt: null, fixed: true }));
  return { staff: [...fixed, ...rows.map((r) => ({ ...r, role: config.adminEmails.includes(r.email.toLowerCase()) ? 'superadmin' : r.role, fixed: config.adminEmails.includes(r.email.toLowerCase()) }))], roles: ROLE_INFO, permissions: PERMISSIONS };
}

export async function addStaff(emailRaw: unknown, roleRaw: unknown, actor: AuthUser) {
  if (!isEmail(emailRaw)) throw new HttpError(422, 'Enter a valid email address.');
  if (!STAFF_ROLES.includes(roleRaw as StaffRole)) throw new HttpError(422, 'Unknown role.');
  const email = emailRaw.trim().toLowerCase();
  let user = await one<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  if (!user) {
    user = { id: newId('usr') };
    await run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', [user.id, email, '', new Date()]);
  }
  await run('INSERT INTO staff (user_id, role, added_by, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)', [user.id, roleRaw, actor.id, new Date()]);
  return { userId: user.id, email };
}

export async function removeStaff(userId: string, actor: AuthUser) {
  if (userId === actor.id) throw new HttpError(409, 'You cannot remove yourself.');
  const n = await run('DELETE FROM staff WHERE user_id = ?', [userId]);
  if (!n) throw new HttpError(404, 'That person is not on staff (people in ADMIN_EMAILS can only be removed there).');
}

export async function auditLog(q: { workspaceId?: string; actor?: string; action?: string; limit?: number; before?: string }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.workspaceId) where.push('workspace_id = ?'), params.push(q.workspaceId);
  if (q.actor) where.push('actor_email LIKE ?'), params.push(`%${q.actor}%`);
  if (q.action) where.push('action = ?'), params.push(q.action);
  if (q.before) where.push('id < ?'), params.push(Number(q.before));
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
  const rows = await all(
    `SELECT id, actor_email AS actor, action, workspace_id AS workspaceId, target, detail, ip, created_at AS at FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`,
    params,
  );
  return { entries: rows.map((r) => ({ ...r, id: String(r.id) })) };
}

/** Puts stuck or failed posts back in the queue (support's "fix it" button). */
export async function requeueTargets(ids: string[], now = new Date()) {
  if (!ids.length) return 0;
  return run(
    "UPDATE post_targets SET status = 'scheduled', attempts = 0, lock_token = NULL, locked_until = NULL, next_attempt_at = ?, due_at = GREATEST(COALESCE(due_at, ?), ?), updated_at = ? WHERE id IN (?) AND (status IN ('scheduled', 'retrying', 'failed') OR (status = 'publishing' AND locked_until < ?))",
    [now, now, addMs(now, -60_000), now, ids, now],
  );
}
