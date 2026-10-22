// Alerts are the "or you know why" half of the promise. Each has a dedupe key, so the
// same problem raises one alert (and one email) until it is resolved.
import { config } from '../config.js';
import { all, run } from '../db.js';
import { emailHtml, sendEmail } from '../mail.js';
import { clip, newId } from '../util.js';

export type AlertInput = {
  workspaceId: string;
  key: string;
  kind: string;
  severity: 'error' | 'warning' | 'info';
  title: string;
  detail?: string;
  clientId?: string | null;
  channelId?: string | null;
  postId?: string | null;
  targetId?: string | null;
};

export async function raiseAlert(a: AlertInput) {
  // Re-raising a resolved alert reopens it (and emails again); an open one is left alone.
  await run(
    `INSERT INTO alerts (id, workspace_id, dedupe_key, kind, severity, title, detail, client_id, channel_id, post_id, target_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title = VALUES(title), detail = VALUES(detail), severity = VALUES(severity),
       emailed_at = IF(resolved_at IS NULL, emailed_at, NULL),
       whatsapp_at = IF(resolved_at IS NULL, whatsapp_at, NULL),
       created_at = IF(resolved_at IS NULL, created_at, VALUES(created_at)),
       resolved_at = NULL`,
    [newId('alr'), a.workspaceId, a.key, a.kind, a.severity, clip(a.title, 300), clip(a.detail ?? null, 1000), a.clientId ?? null, a.channelId ?? null, a.postId ?? null, a.targetId ?? null, new Date()],
  );
}

export async function resolveAlerts(workspaceId: string, keys: string[]) {
  if (!keys.length) return;
  await run('UPDATE alerts SET resolved_at = ? WHERE workspace_id = ? AND dedupe_key IN (?) AND resolved_at IS NULL', [new Date(), workspaceId, keys]);
}

/** Emails new alerts, one message per workspace per tick. */
export async function emailAlerts() {
  const pending = await all<{ id: string; workspace_id: string; severity: string; title: string; detail: string | null }>(
    "SELECT id, workspace_id, severity, title, detail FROM alerts WHERE emailed_at IS NULL AND resolved_at IS NULL AND severity IN ('error', 'warning') ORDER BY created_at LIMIT 200",
  );
  const byWs = new Map<string, typeof pending>();
  for (const a of pending) byWs.set(a.workspace_id, [...(byWs.get(a.workspace_id) ?? []), a]);
  for (const [wsId, alerts] of byWs) {
    const ws = (await all<{ name: string; alert_emails: string | null }>('SELECT name, alert_emails FROM workspaces WHERE id = ?', [wsId]))[0];
    if (!ws) continue;
    let to = (ws.alert_emails ?? '').split(/[,\s]+/).filter(Boolean);
    if (!to.length) to = (await all<{ email: string }>("SELECT u.email FROM members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.role IN ('owner', 'admin')", [wsId])).map((r) => r.email);
    const errors = alerts.filter((a) => a.severity === 'error').length;
    const subject = alerts.length === 1 ? alerts[0].title : `${alerts.length} things need attention${errors ? ` (${errors} failed)` : ''}`;
    const lines = alerts.map((a) => `• ${a.title}${a.detail ? `\n  ${a.detail}` : ''}`);
    try {
      await sendEmail(to, `Surecast: ${subject}`, `${ws.name}\n\n${lines.join('\n\n')}\n\nOpen Surecast: ${config.publicUrl}/alerts`, emailHtml(subject, [ws.name, ...lines], { label: 'Open Surecast', url: `${config.publicUrl}/alerts` }));
      await run('UPDATE alerts SET emailed_at = ? WHERE id IN (?)', [new Date(), alerts.map((a) => a.id)]);
    } catch (e) {
      console.error('Sending alert email failed; will retry next tick', e);
    }
  }
}
