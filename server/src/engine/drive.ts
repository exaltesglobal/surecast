// Google Drive as a workspace's media store. Once connected, new uploads go to a "Surecast"
// folder in the workspace's Drive instead of the Surecast database, and are fetched from there
// when a post goes out. Uses the drive.file scope: Surecast only sees files it created, never
// the rest of the Drive. Shares the Google Cloud app with Google Business Profile and YouTube.
import { HttpError } from '../auth.js';
import { config } from '../config.js';
import { all, one, run } from '../db.js';
import { storeBytes } from './content.js';
import { addMs, clip, decrypt, encrypt, minutes, newId, token } from '../util.js';

const API = 'https://www.googleapis.com';
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];

type Creds = { accessToken: string; refreshToken: string; expiresAt: number; folderId: string };
type Row = { id: string; workspace_id: string; credentials: string; account_name: string | null; status: string; last_error: string | null; last_used_at: Date | null; created_at: Date };

export class DriveError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export const driveRedirectUri = () => `${config.publicUrl}/v1/oauth/gdrive/callback`;
export const driveAvailable = () => !!config.google;

export const getDrive = (workspaceId: string) => one<Row>("SELECT * FROM integrations WHERE workspace_id = ? AND kind = 'gdrive' AND client_id IS NULL", [workspaceId]);

export function driveJson(row: Row | null) {
  if (!row) return null;
  return { account: row.account_name, status: row.status, lastError: row.last_error, lastUsedAt: row.last_used_at, connectedAt: row.created_at };
}

async function google(url: string, init: RequestInit & { accessToken?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.accessToken) headers.set('Authorization', `Bearer ${init.accessToken}`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(4 * 60_000) });
  } catch (e) {
    throw new DriveError(`Could not reach Google Drive: ${(e as Error).message}`);
  }
  if (res.status >= 400) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string; error_description?: string } | null;
    const msg = typeof body?.error === 'string' ? (body.error_description ?? body.error) : (body?.error?.message ?? `HTTP ${res.status}`);
    throw new DriveError(`Google Drive: ${msg}`, res.status);
  }
  return res;
}

/** Step 1: where to send the person to approve access. */
export async function startDrive(workspaceId: string, userId: string) {
  if (!driveAvailable()) throw new HttpError(409, 'Google Drive needs the Google Cloud app. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to switch it on.');
  const state = token(24);
  await run("INSERT INTO oauth_states (state, workspace_id, client_id, user_id, platform, data, expires_at) VALUES (?, ?, '', ?, 'gdrive', '{}', ?)", [
    state,
    workspaceId,
    userId,
    addMs(new Date(), minutes(20)),
  ]);
  const q = new URLSearchParams({
    client_id: config.google!.id,
    redirect_uri: driveRedirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

/** Step 2: Google sends the person back with a code. Saves the connection and makes the folder. */
export async function finishDrive(stateValue: string, code: string) {
  const state = await one<{ workspace_id: string; expires_at: Date }>("SELECT workspace_id, expires_at FROM oauth_states WHERE state = ? AND platform = 'gdrive'", [stateValue]);
  if (!state || state.expires_at < new Date()) throw new DriveError('That connection link expired. Try connecting again.');
  await run('DELETE FROM oauth_states WHERE state = ?', [stateValue]);
  const tok = (await (
    await google(`https://oauth2.googleapis.com/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: driveRedirectUri(), client_id: config.google!.id, client_secret: config.google!.secret }).toString(),
    })
  ).json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
  if (!tok.refresh_token) throw new DriveError('Google did not grant offline access. Remove Surecast from your Google account permissions, then connect again.');
  if (tok.scope && !tok.scope.includes('drive.file')) throw new DriveError('Tick the Google Drive box on the Google screen so Surecast can save files.');
  const who = (await (await google(`${API}/oauth2/v3/userinfo`, { accessToken: tok.access_token })).json()) as { email?: string };
  const ws = await one<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', [state.workspace_id]);
  const folder = (await (
    await google(`${API}/drive/v3/files?fields=id`, {
      method: 'POST',
      accessToken: tok.access_token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `Surecast · ${ws?.name ?? 'Media'}`, mimeType: 'application/vnd.google-apps.folder', description: 'Images and videos for posts scheduled in Surecast. Deleting a file here removes it from those posts.' }),
    })
  ).json()) as { id: string };
  const creds: Creds = { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + tok.expires_in * 1000, folderId: folder.id };
  const existing = await getDrive(state.workspace_id);
  if (existing) {
    await run("UPDATE integrations SET credentials = ?, account_name = ?, status = 'ok', last_error = NULL WHERE id = ?", [encrypt(creds), clip(who.email ?? 'Google Drive', 190), existing.id]);
  } else {
    await run("INSERT INTO integrations (id, workspace_id, client_id, kind, base_url, credentials, account_name, status, created_at) VALUES (?, ?, NULL, 'gdrive', ?, ?, ?, 'ok', ?)", [
      newId('int'),
      state.workspace_id,
      API,
      encrypt(creds),
      clip(who.email ?? 'Google Drive', 190),
      new Date(),
    ]);
  }
  return state.workspace_id;
}

async function accessToken(row: Row) {
  const c = decrypt<Creds>(row.credentials);
  if (c.expiresAt > Date.now() + 5 * 60_000) return c;
  try {
    const t = (await (
      await google('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: config.google!.id, client_secret: config.google!.secret }).toString(),
      })
    ).json()) as { access_token: string; expires_in: number };
    const next = { ...c, accessToken: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    await run('UPDATE integrations SET credentials = ? WHERE id = ?', [encrypt(next), row.id]);
    return next;
  } catch (e) {
    const err = e as DriveError;
    if (err.status === 400 || err.status === 401) {
      const msg = 'Google Drive access was removed. Reconnect Google Drive in Settings.';
      await used(row, msg);
      throw new DriveError(msg, 401);
    }
    throw e;
  }
}

async function used(row: Row, error: string | null) {
  await run('UPDATE integrations SET last_used_at = ?, status = ?, last_error = ? WHERE id = ?', [new Date(), error ? 'error' : 'ok', clip(error, 1000), row.id]);
}

/** Uploads a file into the workspace's Surecast folder and returns its Drive file id. */
export async function uploadToDrive(row: Row, buf: Buffer, filename: string, mime: string) {
  const c = await accessToken(row);
  try {
    const init = await google(`${API}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
      method: 'POST',
      accessToken: c.accessToken,
      headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(buf.length) },
      body: JSON.stringify({ name: filename, parents: [c.folderId] }),
    });
    const location = init.headers.get('location');
    if (!location) throw new DriveError('Google Drive did not return an upload address.');
    const done = (await (await google(location, { method: 'PUT', headers: { 'Content-Type': mime }, body: new Uint8Array(buf) })).json()) as { id: string };
    await used(row, null);
    return done.id;
  } catch (e) {
    const err = e as DriveError;
    await used(row, err.status === 404 ? 'The Surecast folder is missing from Google Drive. Reconnect Google Drive in Settings.' : err.message);
    throw e;
  }
}

/** The bytes of a file Surecast saved to Drive. */
export async function downloadFromDrive(workspaceId: string, fileId: string, filename: string) {
  const row = await getDrive(workspaceId);
  if (!row) throw new DriveError(`${filename} is stored in Google Drive, which is no longer connected. Reconnect the same Google account in Settings.`, 409);
  const c = await accessToken(row);
  try {
    const res = await google(`${API}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { accessToken: c.accessToken });
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    const err = e as DriveError;
    if (err.status === 404) throw new DriveError(`${filename} was removed from Google Drive. Upload it again.`, 404);
    throw e;
  }
}

/** Moves a file to the Drive bin, so it can still be restored from Drive for 30 days. */
export async function trashInDrive(workspaceId: string, fileId: string) {
  const row = await getDrive(workspaceId);
  if (!row) return;
  const c = await accessToken(row);
  await google(`${API}/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    accessToken: c.accessToken,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  }).catch(() => undefined);
}

/**
 * Disconnects Drive. Files used by posts that have not gone out yet are copied back into
 * Surecast first, so nothing scheduled breaks; the rest stay in Drive.
 */
export async function disconnectDrive(workspaceId: string) {
  const row = await getDrive(workspaceId);
  if (!row) return null;
  const pending = await all<{ media_ids: string }>(
    "SELECT media_ids FROM posts WHERE workspace_id = ? AND status IN ('draft', 'awaiting_approval', 'changes_requested', 'scheduled', 'publishing')",
    [workspaceId],
  );
  const ids = [...new Set(pending.flatMap((p) => JSON.parse(p.media_ids || '[]') as string[]))];
  const inDrive = ids.length ? await all<{ id: string; filename: string; drive_file_id: string }>('SELECT id, filename, drive_file_id FROM media WHERE workspace_id = ? AND id IN (?) AND drive_file_id IS NOT NULL', [workspaceId, ids]) : [];
  let copied = 0;
  for (const m of inDrive) {
    const buf = await downloadFromDrive(workspaceId, m.drive_file_id, m.filename);
    await storeBytes(m.id, buf);
    copied++;
  }
  await run('DELETE FROM integrations WHERE id = ?', [row.id]);
  const left = await one<{ n: number }>('SELECT COUNT(*) AS n FROM media WHERE workspace_id = ? AND drive_file_id IS NOT NULL', [workspaceId]);
  return { copied, leftInDrive: Number(left?.n ?? 0) };
}
