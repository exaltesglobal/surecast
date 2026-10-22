// Thin client for the Surecast API. The session is a cookie, so requests are same-origin.
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: { channelId: string; issues: string[] }[],
  ) {
    super(message);
  }
}

const WS_KEY = 'sc_workspace';
export const workspaceId = {
  get: () => {
    try {
      return localStorage.getItem(WS_KEY);
    } catch {
      return null;
    }
  },
  set: (id: string) => {
    try {
      localStorage.setItem(WS_KEY, id);
    } catch {
      /* private mode */
    }
  },
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const ws = workspaceId.get();
  if (ws) headers['X-Workspace-Id'] = ws;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/v1${path}`, {
    method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.details);
  return data as T;
}
