// Sign-in with a 6-digit email code. The session is an opaque token in an httpOnly
// cookie (the web app is served from the same origin). Scripts and AI agents use a
// workspace API key instead: "Authorization: Bearer sc_live_...".
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { config } from './config.js';
import { all, one, run } from './db.js';
import { emailHtml, sendEmail } from './mail.js';
import { addMs, hashSecret, isEmail, minutes, newId, randomString, token } from './util.js';

export type Role = 'owner' | 'admin' | 'editor';
export type AuthUser = { id: string; email: string; name: string };
export type Env = { Variables: { user: AuthUser | null; workspaceId: string; role: Role; viaApiKey: boolean } };

const COOKIE = 'sc_session';
const SESSION_DAYS = 30;

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429,
    message: string,
  ) {
    super(message);
  }
}

export async function requestCode(emailRaw: unknown) {
  if (!isEmail(emailRaw)) throw new HttpError(422, 'Enter a valid email address.');
  const email = emailRaw.trim().toLowerCase();
  const existing = await one<{ expires_at: Date }>('SELECT expires_at FROM login_codes WHERE email = ?', [email]);
  // One code per 30 seconds per address.
  if (existing && existing.expires_at.getTime() - Date.now() > minutes(10) - 30_000) throw new HttpError(429, 'A code was just sent. Wait a moment before asking for another.');
  const code = randomString(6, '0123456789');
  await run('REPLACE INTO login_codes (email, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)', [email, hashSecret(`${email}:${code}`), addMs(new Date(), minutes(10))]);
  await sendEmail(
    email,
    `Your Surecast code: ${code}`,
    `Your sign-in code is ${code}. It expires in 10 minutes.\n\nIf you did not ask for it, ignore this email.`,
    emailHtml(`Your code is ${code}`, ['Enter it in Surecast to sign in. It expires in 10 minutes.', 'If you did not ask for it, ignore this email.']),
  );
}

export async function verifyCode(c: Context, emailRaw: unknown, codeRaw: unknown, nameRaw: unknown) {
  if (!isEmail(emailRaw) || typeof codeRaw !== 'string') throw new HttpError(422, 'Enter your email and the code we sent.');
  const email = emailRaw.trim().toLowerCase();
  const row = await one<{ code_hash: string; expires_at: Date; attempts: number }>('SELECT * FROM login_codes WHERE email = ?', [email]);
  if (!row || row.expires_at < new Date() || row.attempts >= 5) throw new HttpError(401, 'That code has expired. Ask for a new one.');
  if (row.code_hash !== hashSecret(`${email}:${codeRaw.trim()}`)) {
    await run('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?', [email]);
    throw new HttpError(401, 'That code is not right. Check the email and try again.');
  }
  await run('DELETE FROM login_codes WHERE email = ?', [email]);
  let user = await one<AuthUser>('SELECT id, email, name FROM users WHERE email = ?', [email]);
  if (!user) {
    user = { id: newId('usr'), email, name: typeof nameRaw === 'string' ? nameRaw.trim().slice(0, 120) : '' };
    await run('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', [user.id, user.email, user.name, new Date()]);
  }
  const memberships = await all('SELECT workspace_id FROM members WHERE user_id = ?', [user.id]);
  if (!memberships.length) {
    const wsId = newId('wsp');
    const now = new Date();
    await run('INSERT INTO workspaces (id, name, timezone, created_at) VALUES (?, ?, ?, ?)', [wsId, user.name ? `${user.name.split(' ')[0]}'s agency` : 'My agency', 'UTC', now]);
    await run("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", [wsId, user.id, now]);
  }
  const t = token(32);
  await run('INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', [newId('ses'), user.id, hashSecret(t), addMs(new Date(), SESSION_DAYS * 86_400_000), new Date()]);
  setCookie(c, COOKIE, t, { httpOnly: true, secure: config.production, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86_400 });
  return user;
}

export async function logout(c: Context) {
  const t = getCookie(c, COOKIE);
  if (t) await run('DELETE FROM sessions WHERE token_hash = ?', [hashSecret(t)]);
  deleteCookie(c, COOKIE, { path: '/' });
}

/** Loads the signed-in user (cookie) or API key, and the workspace in play. */
export const authenticate: MiddlewareHandler<Env> = async (c, next) => {
  c.set('user', null);
  c.set('viaApiKey', false);
  const bearer = c.req.header('Authorization')?.match(/^Bearer\s+(sc_live_\S+)$/)?.[1];
  if (bearer) {
    const key = await one<{ id: string; workspace_id: string; created_by: string }>('SELECT id, workspace_id, created_by FROM api_keys WHERE key_hash = ?', [hashSecret(bearer)]);
    if (!key) throw new HttpError(401, 'Unknown API key.');
    const user = await one<AuthUser>('SELECT id, email, name FROM users WHERE id = ?', [key.created_by]);
    await run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [new Date(), key.id]);
    c.set('user', user);
    c.set('workspaceId', key.workspace_id);
    c.set('role', 'editor');
    c.set('viaApiKey', true);
    return next();
  }
  const t = getCookie(c, COOKIE);
  if (t) {
    const user = await one<AuthUser>('SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?', [hashSecret(t), new Date()]);
    if (user) {
      c.set('user', user);
      const wanted = c.req.header('X-Workspace-Id');
      const m = await one<{ workspace_id: string; role: Role }>(
        wanted ? 'SELECT workspace_id, role FROM members WHERE user_id = ? AND workspace_id = ?' : 'SELECT workspace_id, role FROM members WHERE user_id = ? ORDER BY created_at LIMIT 1',
        wanted ? [user.id, wanted] : [user.id],
      );
      if (m) {
        c.set('workspaceId', m.workspace_id);
        c.set('role', m.role);
      }
    }
  }
  return next();
};

export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get('user') || !c.get('workspaceId')) throw new HttpError(401, 'Sign in to continue.');
  return next();
};

export const requireAdmin: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('role') !== 'owner' && c.get('role') !== 'admin') throw new HttpError(403, 'Only workspace admins can do this.');
  return next();
};

export const generateApiKey = () => `sc_live_${token(24)}`;
