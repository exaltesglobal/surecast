// Outgoing webhooks: POST a signed JSON event when a post is published or fails.
// Signature: X-Surecast-Signature = hex HMAC-SHA256 of the raw body with the webhook secret.
import { all, run } from '../db.js';
import { hmac } from '../util.js';

export async function emitEvent(workspaceId: string, type: string, data: Record<string, unknown>) {
  const hooks = await all<{ id: string; url: string; secret: string }>('SELECT id, url, secret FROM webhooks WHERE workspace_id = ?', [workspaceId]);
  for (const h of hooks) {
    const body = JSON.stringify({ type, created_at: new Date().toISOString(), data });
    let status = 0;
    try {
      const res = await fetch(h.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Surecast-Event': type, 'X-Surecast-Signature': hmac(h.secret, body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
    } catch {
      status = 0;
    }
    await run('UPDATE webhooks SET last_status = ?, last_sent_at = ? WHERE id = ?', [status, new Date(), h.id]);
  }
}
