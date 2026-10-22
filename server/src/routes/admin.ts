// The Surecast team's admin panel. To anyone who is not on staff these routes do not exist (404).
import { Hono, type Context, type MiddlewareHandler } from 'hono';

import { HttpError, startImpersonation, type Env } from '../auth.js';
import { all, one, run } from '../db.js';
import {
  addStaff,
  audit,
  auditLog,
  can,
  deleteWorkspace,
  health,
  listAnnouncements,
  listStaff,
  listUsers,
  listWorkspaces,
  overview,
  permissionsOf,
  PLANS,
  removeStaff,
  requeueTargets,
  saveAnnouncement,
  staffRole,
  suspendWorkspace,
  unsuspendWorkspace,
  updateWorkspace,
  workspaceDetail,
  type Permission,
  type StaffRole,
} from '../engine/admin.js';
import { rollupPost } from '../engine/publisher.js';
import { body } from './workspace.js';

type AdminEnv = { Variables: Env['Variables'] & { staffRole: StaffRole } };

const ip = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;

const staffOnly: MiddlewareHandler<AdminEnv> = async (c, next) => {
  // While viewing as a customer, the admin panel is out of reach: stop viewing first.
  const role = c.get('impersonatedBy') ? null : await staffRole(c.get('user'));
  if (!role) throw new HttpError(404, 'Not found');
  c.set('staffRole', role);
  return next();
};

const need =
  (p: Permission): MiddlewareHandler<AdminEnv> =>
  async (c, next) => {
    if (!can(c.get('staffRole'), p)) throw new HttpError(403, `Your staff role (${c.get('staffRole')}) cannot do this.`);
    return next();
  };

const log = (c: Context<AdminEnv>, action: string, opts: { workspaceId?: string | null; target?: string | null; detail?: unknown } = {}) => audit(c.get('user')!, action, { ...opts, ip: ip(c) });

export const adminRoutes = new Hono<AdminEnv>()
  .use('/admin/*', staffOnly)
  .get('/admin/me', async (c) => c.json({ role: c.get('staffRole'), permissions: permissionsOf(c.get('staffRole')), plans: PLANS }))
  .get('/admin/overview', async (c) => c.json(await overview()))

  // Workspaces
  .get('/admin/workspaces', async (c) =>
    c.json(
      await listWorkspaces({
        search: c.req.query('q')?.trim() || undefined,
        plan: c.req.query('plan') || undefined,
        status: c.req.query('status') || undefined,
        limit: Number(c.req.query('limit')) || 50,
        offset: Number(c.req.query('offset')) || 0,
      }),
    ),
  )
  .get('/admin/workspaces/:id', async (c) => c.json(await workspaceDetail(c.req.param('id'))))
  .patch('/admin/workspaces/:id', need('workspaces.manage'), async (c) => {
    const b = await body(c);
    const before = await one('SELECT plan, trial_ends_at FROM workspaces WHERE id = ?', [c.req.param('id')]);
    await updateWorkspace(c.req.param('id'), b);
    await log(c, 'workspace.update', { workspaceId: c.req.param('id'), detail: { before, change: { ...b, staffNotes: b.staffNotes !== undefined ? '(edited)' : undefined } } });
    return c.json({ ok: true });
  })
  .post('/admin/workspaces/:id/suspend', need('workspaces.suspend'), async (c) => {
    const reason = String((await body(c)).reason ?? '');
    const r = await suspendWorkspace(c.req.param('id'), reason, c.get('user')!);
    await log(c, 'workspace.suspend', { workspaceId: c.req.param('id'), detail: { reason, held: r.held } });
    return c.json(r);
  })
  .post('/admin/workspaces/:id/unsuspend', need('workspaces.suspend'), async (c) => {
    const r = await unsuspendWorkspace(c.req.param('id'), c.get('user')!);
    await log(c, 'workspace.unsuspend', { workspaceId: c.req.param('id'), detail: r });
    return c.json(r);
  })
  .delete('/admin/workspaces/:id', need('workspaces.delete'), async (c) => {
    const r = await deleteWorkspace(c.req.param('id'), (await body(c)).confirm);
    await log(c, 'workspace.delete', { workspaceId: c.req.param('id'), target: r.name, detail: r });
    return c.json(r);
  })
  .post('/admin/workspaces/:id/impersonate', need('impersonate'), async (c) => {
    const id = c.req.param('id');
    const reason = String((await body(c)).reason ?? '').trim();
    if (!reason) throw new HttpError(422, 'Say why you need to see this workspace. It goes in the audit log.');
    const owner = await one<{ user_id: string; email: string }>(
      "SELECT m.user_id, u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY FIELD(m.role, 'owner', 'admin', 'editor'), m.created_at LIMIT 1",
      [id],
    );
    if (!owner) throw new HttpError(404, 'This workspace has no members to view as.');
    await startImpersonation(c, c.get('user')!.id, owner.user_id);
    await log(c, 'workspace.impersonate', { workspaceId: id, target: owner.email, detail: { reason } });
    return c.json({ ok: true, workspaceId: id, viewingAs: owner.email });
  })

  // People
  .get('/admin/users', async (c) => c.json(await listUsers({ search: c.req.query('q')?.trim() || undefined, limit: Number(c.req.query('limit')) || 50 })))

  // Publishing health across the service
  .get('/admin/health', async (c) => c.json(await health()))
  .post('/admin/targets/requeue', need('publishing.ops'), async (c) => {
    const b = await body(c);
    const ids: string[] = Array.isArray(b.ids) ? b.ids.filter((x: unknown): x is string => typeof x === 'string').slice(0, 200) : [];
    const n = await requeueTargets(ids);
    const posts = ids.length ? await all<{ post_id: string; workspace_id: string }>('SELECT DISTINCT post_id, workspace_id FROM post_targets WHERE id IN (?)', [ids]) : [];
    for (const p of posts) await rollupPost(p.post_id);
    await log(c, 'publishing.requeue', { workspaceId: posts.length === 1 ? posts[0].workspace_id : null, detail: { ids, requeued: n } });
    return c.json({ requeued: n });
  })

  // Announcements
  .get('/admin/announcements', async (c) => c.json({ announcements: await listAnnouncements() }))
  .post('/admin/announcements', need('announcements'), async (c) => {
    const b = await body(c);
    const id = await saveAnnouncement(b, c.get('user')!);
    await log(c, 'announcement.create', { target: id, detail: { title: b.title } });
    return c.json({ id }, 201);
  })
  .patch('/admin/announcements/:id', need('announcements'), async (c) => {
    const b = await body(c);
    await saveAnnouncement(b, c.get('user')!, c.req.param('id'));
    await log(c, 'announcement.update', { target: c.req.param('id'), detail: { title: b.title } });
    return c.json({ ok: true });
  })
  .delete('/admin/announcements/:id', need('announcements'), async (c) => {
    await run('DELETE FROM announcements WHERE id = ?', [c.req.param('id')]);
    await log(c, 'announcement.delete', { target: c.req.param('id') });
    return c.json({ ok: true });
  })

  // Staff
  .get('/admin/staff', async (c) => c.json(await listStaff()))
  .post('/admin/staff', need('staff'), async (c) => {
    const b = await body(c);
    const r = await addStaff(b.email, b.role, c.get('user')!);
    await log(c, 'staff.add', { target: r.email, detail: { role: b.role } });
    return c.json(r, 201);
  })
  .delete('/admin/staff/:userId', need('staff'), async (c) => {
    await removeStaff(c.req.param('userId'), c.get('user')!);
    await log(c, 'staff.remove', { target: c.req.param('userId') });
    return c.json({ ok: true });
  })

  // Audit log
  .get('/admin/audit', need('audit'), async (c) =>
    c.json(
      await auditLog({
        workspaceId: c.req.query('workspace') || undefined,
        actor: c.req.query('actor') || undefined,
        action: c.req.query('action') || undefined,
        before: c.req.query('before') || undefined,
        limit: Number(c.req.query('limit')) || 100,
      }),
    ),
  );

