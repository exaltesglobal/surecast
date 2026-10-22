// Chitthi is the WhatsApp Business app from the same team. Connecting it gives Surecast two
// things no other scheduler has:
//  - Agency connection: approval requests go to the client on WhatsApp (where they actually
//    answer), and failed-post alerts reach the agency's phones within a minute.
//  - Client connection: the client's own WhatsApp chats land in the unified inbox next to their
//    social comments, and replies go back through their WhatsApp number.
// API: Authorization: Bearer chk_live_...; webhooks are signed "t=<unix>,v1=<hmac(secret, t.body)>".
import { timingSafeEqual } from 'node:crypto';

import { HttpError } from '../auth.js';
import { config } from '../config.js';
import { all, json, one, run, type Row } from '../db.js';
import { addMs, clip, decrypt, encrypt, hmac, minutes, newId, token } from '../util.js';

export type ChitthiSettings = {
  /** Agency phones that get failed-post alerts. */
  alertPhones: string[];
  alerts: boolean;
  approvals: boolean;
  /** Approved WhatsApp templates for when the 24-hour window is closed (it usually is). */
  approvalTemplate: { name: string; language: string } | null;
  alertTemplate: { name: string; language: string } | null;
};
const DEFAULTS: ChitthiSettings = { alertPhones: [], alerts: true, approvals: true, approvalTemplate: null, alertTemplate: null };

type IntegrationRow = Row & {
  id: string;
  workspace_id: string;
  client_id: string | null;
  base_url: string;
  credentials: string;
  settings: string | null;
  account_name: string | null;
  hook_id: string | null;
  hook_token: string | null;
  status: string;
  last_error: string | null;
};
type Creds = { apiKey: string; hookSecret?: string };

/** "+91 98765-43210" -> "+919876543210", or null if it is not a phone number. */
export function cleanPhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const digits = v.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{8,15}$/.test(digits)) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

function cleanTemplate(v: unknown) {
  const t = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  const name = typeof t?.name === 'string' ? t.name.trim().slice(0, 120) : '';
  if (!name || !/^[a-z0-9_]+$/.test(name)) return null;
  const language = typeof t?.language === 'string' && /^[a-z]{2}(_[A-Z]{2})?$/.test(t.language) ? t.language : 'en';
  return { name, language };
}

export function cleanSettings(v: unknown, prev: ChitthiSettings = DEFAULTS): ChitthiSettings {
  const s = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const phones = Array.isArray(s.alertPhones) ? s.alertPhones : typeof s.alertPhones === 'string' ? s.alertPhones.split(/[,\n]+/) : null;
  return {
    alertPhones: phones ? [...new Set(phones.map(cleanPhone).filter((p): p is string => !!p))].slice(0, 10) : prev.alertPhones,
    alerts: typeof s.alerts === 'boolean' ? s.alerts : prev.alerts,
    approvals: typeof s.approvals === 'boolean' ? s.approvals : prev.approvals,
    approvalTemplate: s.approvalTemplate !== undefined ? cleanTemplate(s.approvalTemplate) : prev.approvalTemplate,
    alertTemplate: s.alertTemplate !== undefined ? cleanTemplate(s.alertTemplate) : prev.alertTemplate,
  };
}

const settingsOf = (row: IntegrationRow) => ({ ...DEFAULTS, ...json<Partial<ChitthiSettings>>(row.settings, {}) });

export class ChitthiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Tests replace the network here. */
type Transport = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; body: any }>;
const network: Transport = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
let transport: Transport = network;
export const overrideChitthi = (t: Transport | null) => (transport = t ?? network);

async function call(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  let r: { status: number; body: any };
  try {
    r = await transport(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'Surecast/1.0 (+https://surecast.live)' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ChitthiError(0, `Could not reach Chitthi: ${(e as Error).message}`);
  }
  if (r.status >= 400) throw new ChitthiError(r.status, typeof r.body?.error === 'string' ? r.body.error : `Chitthi answered with HTTP ${r.status}`);
  return r.body;
}

const creds = (row: IntegrationRow) => decrypt<Creds>(row.credentials);

export async function getIntegration(workspaceId: string, clientId: string | null) {
  return one<IntegrationRow>(
    `SELECT * FROM integrations WHERE workspace_id = ? AND kind = 'chitthi' AND ${clientId ? 'client_id = ?' : 'client_id IS NULL'}`,
    clientId ? [workspaceId, clientId] : [workspaceId],
  );
}

export function integrationJson(row: IntegrationRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    account: row.account_name,
    status: row.status,
    lastError: row.last_error,
    lastUsedAt: row.last_used_at ?? null,
    inbox: !!row.hook_id,
    connectedAt: row.created_at,
    ...(row.client_id ? {} : { settings: settingsOf(row) }),
  };
}

/** Connects a Chitthi workspace with its API key. For a client, also subscribes to their incoming WhatsApp messages. */
export async function connectChitthi(workspaceId: string, clientId: string | null, apiKeyRaw: unknown, settingsIn?: unknown) {
  const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : '';
  if (!/^chk_live_[A-Za-z0-9_-]{8,}$/.test(apiKey)) throw new HttpError(422, 'Paste a Chitthi API key. It starts with chk_live_ (Chitthi > Settings > API keys).');
  if (clientId && !(await one('SELECT id FROM clients WHERE id = ? AND workspace_id = ?', [clientId, workspaceId]))) throw new HttpError(404, 'Client not found.');
  const base = config.chitthiUrl;
  let account: string;
  try {
    const r = await call(base, apiKey, 'GET', '/api/integrations/hooks');
    account = typeof r.workspace === 'string' ? r.workspace : 'Chitthi';
  } catch (e) {
    const err = e as ChitthiError;
    throw new HttpError(err.status === 401 ? 422 : 502, err.status === 401 ? 'Chitthi did not accept that API key.' : `Could not check the key with Chitthi: ${err.message}`);
  }
  await disconnectChitthi(workspaceId, clientId);
  const c: Creds = { apiKey };
  let hookId: string | null = null;
  let hookToken: string | null = null;
  if (clientId) {
    hookToken = token(24);
    try {
      const h = await call(base, apiKey, 'POST', '/api/integrations/hooks', { target_url: `${config.publicUrl}/v1/hooks/chitthi/${hookToken}`, event: 'message.received' });
      hookId = String(h.id);
      c.hookSecret = String(h.secret);
    } catch (e) {
      const err = e as ChitthiError;
      throw new HttpError(err.status === 402 ? 422 : 502, err.status === 402 ? "Bringing WhatsApp chats into the inbox needs Chitthi's Growth plan." : `Chitthi would not send us new messages: ${err.message}`);
    }
  }
  const id = newId('int');
  await run(
    "INSERT INTO integrations (id, workspace_id, client_id, kind, base_url, credentials, settings, account_name, hook_id, hook_token, status, created_at) VALUES (?, ?, ?, 'chitthi', ?, ?, ?, ?, ?, ?, 'ok', ?)",
    [id, workspaceId, clientId, base, encrypt(c), clientId ? null : JSON.stringify(cleanSettings(settingsIn)), clip(account, 190), hookId, hookToken, new Date()],
  );
  return integrationJson(await getIntegration(workspaceId, clientId));
}

export async function updateChitthiSettings(workspaceId: string, settingsIn: unknown) {
  const row = await getIntegration(workspaceId, null);
  if (!row) throw new HttpError(404, 'Connect Chitthi first.');
  await run('UPDATE integrations SET settings = ? WHERE id = ?', [JSON.stringify(cleanSettings(settingsIn, settingsOf(row))), row.id]);
  return integrationJson(await getIntegration(workspaceId, null));
}

export async function disconnectChitthi(workspaceId: string, clientId: string | null) {
  const row = await getIntegration(workspaceId, clientId);
  if (!row) return false;
  if (row.hook_id) await call(row.base_url, creds(row).apiKey, 'DELETE', `/api/integrations/hooks/${encodeURIComponent(row.hook_id)}`).catch(() => undefined);
  await run('DELETE FROM integrations WHERE id = ?', [row.id]);
  return true;
}

async function used(row: IntegrationRow, error: string | null) {
  await run('UPDATE integrations SET last_used_at = ?, status = ?, last_error = ? WHERE id = ?', [new Date(), error ? 'error' : 'ok', clip(error, 1000), row.id]);
}

/**
 * Sends a WhatsApp message. A free-form message only works inside the 24-hour window after the
 * person last wrote; otherwise Chitthi answers 409 and we fall back to the approved template.
 */
async function send(row: IntegrationRow, to: string, text: string, template: { name: string; language: string } | null, params: string[]) {
  const key = creds(row).apiKey;
  try {
    try {
      await call(row.base_url, key, 'POST', '/api/v1/messages', { to, text: text.slice(0, 4096) });
    } catch (e) {
      if ((e as ChitthiError).status !== 409 || !template) throw e;
      await call(row.base_url, key, 'POST', '/api/v1/messages', { to, template: template.name, language: template.language, params });
    }
    await used(row, null);
    return true;
  } catch (e) {
    const err = e as ChitthiError;
    const msg = err.status === 409 ? `${err.message} Add an approved template in the Chitthi settings so messages always arrive.` : err.message;
    await used(row, msg);
    throw new ChitthiError(err.status, msg);
  }
}

/** Approval request to the client's WhatsApp, if the agency connected Chitthi. */
export async function whatsappApproval(workspaceId: string, phone: string, clientName: string, url: string) {
  const row = await getIntegration(workspaceId, null);
  if (!row) return false;
  const s = settingsOf(row);
  if (!s.approvals) return false;
  return send(row, phone, `Hello! A new post for ${clientName} is ready for your approval. Review it here (no login needed):\n${url}`, s.approvalTemplate, [clientName, url]);
}

/** Failed posts and other errors, to the agency's phones. One message per workspace per run. */
export async function whatsappAlerts(now = new Date()) {
  const pending = await all<{ id: string; workspace_id: string; title: string }>(
    "SELECT a.id, a.workspace_id, a.title FROM alerts a JOIN integrations i ON i.workspace_id = a.workspace_id AND i.kind = 'chitthi' AND i.client_id IS NULL WHERE a.whatsapp_at IS NULL AND a.resolved_at IS NULL AND a.severity = 'error' AND a.created_at >= ? ORDER BY a.created_at LIMIT 200",
    [addMs(now, -minutes(60))],
  );
  const byWs = new Map<string, typeof pending>();
  for (const a of pending) byWs.set(a.workspace_id, [...(byWs.get(a.workspace_id) ?? []), a]);
  let sent = 0;
  for (const [wsId, alerts] of byWs) {
    const row = await getIntegration(wsId, null);
    const s = row && settingsOf(row);
    // Mark them either way, so switching alerts on later does not replay old ones.
    await run('UPDATE alerts SET whatsapp_at = ? WHERE id IN (?)', [now, alerts.map((a) => a.id)]);
    if (!row || !s || !s.alerts || !s.alertPhones.length) continue;
    const summary = alerts.length === 1 ? alerts[0].title : `${alerts.length} posts need attention`;
    const text = `Surecast: ${summary}\n\n${alerts.slice(0, 5).map((a) => `• ${a.title}`).join('\n')}${alerts.length > 5 ? `\n…and ${alerts.length - 5} more` : ''}\n\n${config.publicUrl}/alerts`;
    for (const phone of s.alertPhones) {
      try {
        await send(row, phone, text, s.alertTemplate, [summary, `${config.publicUrl}/alerts`]);
        sent++;
      } catch (e) {
        console.error('WhatsApp alert failed', (e as Error).message);
      }
    }
  }
  return sent;
}

export async function testChitthi(workspaceId: string) {
  const row = await getIntegration(workspaceId, null);
  if (!row) throw new HttpError(404, 'Connect Chitthi first.');
  const s = settingsOf(row);
  if (!s.alertPhones.length) throw new HttpError(422, 'Add at least one phone number for alerts first.');
  const results = [];
  for (const phone of s.alertPhones) {
    try {
      await send(row, phone, 'Surecast is connected to WhatsApp. Failed posts and other problems will show up here.', s.alertTemplate, ['Surecast is connected', `${config.publicUrl}/alerts`]);
      results.push({ phone, ok: true });
    } catch (e) {
      results.push({ phone, ok: false, error: (e as Error).message });
    }
  }
  return { results };
}

function verify(body: string, header: string | undefined, secret: string, now = Math.floor(Date.now() / 1000)) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(now - t) > 300) return false;
  const want = Buffer.from(hmac(secret, `${t}.${body}`));
  const got = Buffer.from(parts.v1);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Incoming webhook from a client's Chitthi: a WhatsApp message becomes an inbox item. */
export async function receiveHook(hookToken: string, raw: string, signature: string | undefined) {
  const row = await one<IntegrationRow>("SELECT * FROM integrations WHERE hook_token = ? AND kind = 'chitthi'", [hookToken]);
  if (!row || !row.client_id) throw new HttpError(404, 'Unknown hook.');
  if (!verify(raw, signature, creds(row).hookSecret ?? '')) throw new HttpError(401, 'Bad signature.');
  let event: { id?: string; event?: string; data?: Record<string, any> };
  try {
    event = JSON.parse(raw);
  } catch {
    throw new HttpError(422, 'Body must be JSON.');
  }
  if (event.event !== 'message.received' || !event.data) return { stored: false };
  const d = event.data;
  const phone = cleanPhone(d.contact?.phone) ?? '';
  const text = typeof d.text === 'string' ? d.text : '';
  if (!phone || !text.trim()) return { stored: false };
  const remoteId = String(d.wa_message_id ?? event.id ?? token(9));
  const now = new Date();
  const stored = await run(
    `INSERT IGNORE INTO inbox_items (id, workspace_id, client_id, channel_id, target_id, post_id, platform, remote_id, parent_remote_id, root_remote_id, author_name, author_handle, body, received_at, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId('inb'), row.workspace_id, row.client_id, row.id, clip(remoteId, 190), clip(String(d.conversation_id ?? phone), 190), phone, clip(d.contact?.name || phone, 190), phone, text.slice(0, 10_000), now, now],
  );
  await run("UPDATE integrations SET last_used_at = ?, status = 'ok', last_error = NULL WHERE id = ?", [now, row.id]);
  return { stored: stored > 0 };
}

/** Replies to a WhatsApp chat from the inbox. Free-form replies only work within 24 hours of their message. */
export async function replyOnWhatsApp(integrationId: string, phone: string, text: string) {
  const row = await one<IntegrationRow>('SELECT * FROM integrations WHERE id = ?', [integrationId]);
  if (!row) throw new HttpError(409, 'WhatsApp was disconnected for this client. Reconnect Chitthi to reply.');
  try {
    await call(row.base_url, creds(row).apiKey, 'POST', '/api/v1/messages', { to: phone, text: text.slice(0, 4096) });
    await used(row, null);
    return { remoteId: null as string | null };
  } catch (e) {
    const err = e as ChitthiError;
    if (err.status === 409) throw new HttpError(409, 'WhatsApp only allows free replies within 24 hours of their last message. Reply from Chitthi with a template instead.');
    await used(row, err.message);
    throw new HttpError(502, `WhatsApp did not accept the reply: ${err.message}`);
  }
}
