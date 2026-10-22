import { Bot, Hash, KeyRound, Trash2, Webhook } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useApp } from '../components/Layout';
import { CopyField, ErrorBanner, Loading, Modal, useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';
import { ago, TIMEZONES } from '../lib/time';
import type { Snippet } from '../lib/types';

type Member = { id: string; email: string; name: string; role: string };

export function SettingsPage() {
  const { me } = useApp();
  const role = me.workspaces.find((w) => w.id === me.workspaceId)?.role;
  const admin = role === 'owner' || role === 'admin';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Your workspace, team and integrations.</p>
        </div>
      </div>
      <div className="grid two" style={{ alignItems: 'start' }}>
        <div className="stack">
          <WorkspaceForm admin={admin} />
          <Team admin={admin} />
          <Snippets />
        </div>
        <div className="stack">{admin ? <><ApiKeys /><AgentAccess /><Webhooks /></> : <div className="card pad muted">Ask a workspace admin to manage API keys and webhooks.</div>}</div>
      </div>
    </>
  );
}

function WorkspaceForm({ admin }: { admin: boolean }) {
  const toast = useToast();
  const { data } = useLoad(() => api<{ workspace: { name: string; timezone: string; alertEmails: string } }>('/workspace'));
  const [form, setForm] = useState({ name: '', timezone: 'UTC', alertEmails: '' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (data) setForm({ name: data.workspace.name, timezone: data.workspace.timezone, alertEmails: data.workspace.alertEmails });
  }, [data]);
  if (!data) return <Loading />;
  return (
    <form
      className="card pad stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/workspace', { method: 'PATCH', body: form });
          setError(null);
          toast('Saved. Reloading…');
          setTimeout(() => window.location.reload(), 600);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <h2>Workspace</h2>
      <label className="field">
        Agency name
        <input className="input" disabled={!admin} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label className="field">
        Default time zone
        <select className="input" disabled={!admin} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
          {TIMEZONES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label className="field">
        Send alerts to <span className="hint">Comma separated. Leave empty to alert every owner and admin.</span>
        <input className="input" disabled={!admin} value={form.alertEmails} onChange={(e) => setForm({ ...form, alertEmails: e.target.value })} placeholder="ops@youragency.com" />
      </label>
      <ErrorBanner error={error} />
      {admin && <button className="btn primary" style={{ alignSelf: 'flex-start' }}>Save</button>}
    </form>
  );
}

function Team({ admin }: { admin: boolean }) {
  const toast = useToast();
  const { me } = useApp();
  const { data, reload } = useLoad(() => api<{ members: Member[] }>('/members'));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Team</h2>
        <span className="small muted">Unlimited seats</span>
      </div>
      <div className="list">
        {data?.members.map((m) => (
          <div key={m.id} className="list-item" style={{ alignItems: 'center' }}>
            <div className="grow">
              <strong>{m.name || m.email}</strong>
              <div className="tiny muted">{m.email}</div>
            </div>
            {admin && m.id !== me.user.id ? (
              <select
                className="input"
                style={{ width: 'auto' }}
                value={m.role}
                onChange={async (e) => {
                  try {
                    await api(`/members/${m.id}`, { method: 'PATCH', body: { role: e.target.value } });
                    reload();
                  } catch (err) {
                    toast((err as Error).message, 'error');
                  }
                }}
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
              </select>
            ) : (
              <span className="pill neutral">{m.role}</span>
            )}
            {admin && m.id !== me.user.id && (
              <button
                className="btn ghost sm danger"
                aria-label="Remove"
                onClick={async () => {
                  if (!confirm(`Remove ${m.email}?`)) return;
                  await api(`/members/${m.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
                  reload();
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
      {admin && (
        <form
          className="card-body stack"
          style={{ borderTop: '1px solid var(--line)' }}
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('/members', { body: { email, role } });
              setEmail('');
              setError(null);
              toast('Invitation sent');
              reload();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <div className="row">
            <input className="input" style={{ flex: 1, minWidth: 200 }} type="email" required placeholder="teammate@agency.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select className="input" style={{ width: 'auto' }} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
            <button className="btn primary">Invite</button>
          </div>
          <ErrorBanner error={error} />
        </form>
      )}
    </section>
  );
}

function ApiKeys() {
  const { data, reload } = useLoad(() => api<{ keys: { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }[] }>('/api-keys'));
  const [created, setCreated] = useState<string | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <KeyRound size={18} style={{ verticalAlign: -3 }} /> API keys
        </h2>
        <button
          className="btn sm"
          onClick={async () => {
            const name = prompt('Name this key (for example "Zapier" or "AI agent")');
            if (name === null) return;
            const r = await api<{ key: string }>('/api-keys', { body: { name } });
            setCreated(r.key);
            reload();
          }}
        >
          New key
        </button>
      </div>
      <div className="card-body small muted">
        Use a key to schedule posts from scripts, Zapier or AI agents: <span className="kbd">Authorization: Bearer sc_live_…</span> against <span className="kbd">{location.origin}/v1</span>.
      </div>
      <div className="list">
        {data?.keys.map((k) => (
          <div key={k.id} className="list-item" style={{ alignItems: 'center' }}>
            <div className="grow">
              <strong>{k.name}</strong>
              <div className="tiny muted mono">
                {k.prefix}… · last used {ago(k.lastUsedAt)}
              </div>
            </div>
            <button
              className="btn ghost sm danger"
              aria-label="Revoke"
              onClick={async () => {
                if (!confirm(`Revoke ${k.name}? Anything using it stops working.`)) return;
                await api(`/api-keys/${k.id}`, { method: 'DELETE' });
                reload();
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      {created && (
        <Modal title="Your new API key" onClose={() => setCreated(null)}>
          <p>Copy it now. For your security it won't be shown again.</p>
          <CopyField value={created} />
        </Modal>
      )}
    </section>
  );
}

/** How to connect AI agents through the MCP server. */
function AgentAccess() {
  const url = `${location.origin}/mcp`;
  return (
    <section className="card pad stack">
      <h2>
        <Bot size={18} style={{ verticalAlign: -3 }} /> Connect AI agents (MCP)
      </h2>
      <p className="small muted">
        Claude, ChatGPT, Cursor and other agents can list clients, schedule posts into the queue, check delivery, read analytics and answer comments. Add this server to the agent with an API key from above as a Bearer token.
      </p>
      <CopyField value={url} />
      <div className="tiny muted">For Claude Code:</div>
      <CopyField value={`claude mcp add --transport http surecast ${url} --header "Authorization: Bearer sc_live_..."`} />
      <p className="tiny muted">Posts from agents get the same checks, client approval and delivery guarantees as posts made here. Revoke the key to cut an agent off.</p>
    </section>
  );
}

function Webhooks() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api<{ webhooks: { id: string; url: string; secret: string; lastStatus: number | null; lastSentAt: string | null }[] }>('/webhooks'));
  const [url, setUrl] = useState('');
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Webhook size={18} style={{ verticalAlign: -3 }} /> Webhooks
        </h2>
        {!!data?.webhooks.length && (
          <button
            className="btn sm"
            onClick={async () => {
              await api('/webhooks/test', { method: 'POST' });
              toast('Test event sent');
              reload();
            }}
          >
            Send test
          </button>
        )}
      </div>
      <div className="card-body small muted">
        We POST <span className="kbd">post.published</span> and <span className="kbd">post.failed</span> events, signed with HMAC-SHA256 in <span className="kbd">X-Surecast-Signature</span>.
      </div>
      <div className="list">
        {data?.webhooks.map((w) => (
          <div key={w.id} className="list-item">
            <div className="grow stack" style={{ gap: 6 }}>
              <strong className="small mono" style={{ wordBreak: 'break-all' }}>
                {w.url}
              </strong>
              <span className="tiny muted">
                Signing secret: <span className="mono">{w.secret}</span>
              </span>
              <span className="tiny muted">{w.lastSentAt ? `Last delivery ${ago(w.lastSentAt)}: ${w.lastStatus || 'no response'}` : 'No deliveries yet'}</span>
            </div>
            <button
              className="btn ghost sm danger"
              aria-label="Delete"
              onClick={async () => {
                await api(`/webhooks/${w.id}`, { method: 'DELETE' });
                reload();
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      <form
        className="card-body row"
        style={{ borderTop: '1px solid var(--line)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/webhooks', { body: { url } });
            setUrl('');
            reload();
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        }}
      >
        <input className="input" style={{ flex: 1 }} type="url" required placeholder="https://example.com/surecast-hook" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn">Add</button>
      </form>
    </section>
  );
}

/** Hashtag groups, signatures and disclaimers to drop into any post. */
function Snippets() {
  const toast = useToast();
  const { clients } = useApp();
  const { data, reload } = useLoad(() => api<{ snippets: Snippet[] }>('/snippets'));
  const [form, setForm] = useState({ name: '', body: '', clientId: '' });
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <Hash size={18} style={{ verticalAlign: -3 }} /> Snippets and hashtag groups
        </h2>
      </div>
      <div className="card-body small muted">Save text you use often, like a hashtag set or a sign-off. Insert it from the composer.</div>
      <div className="list">
        {data?.snippets.map((sn) => (
          <div key={sn.id} className="list-item">
            <div className="grow" style={{ minWidth: 0 }}>
              <strong className="small">{sn.name}</strong> <span className="tiny muted">{sn.clientId ? clients.find((c) => c.id === sn.clientId)?.name : 'All clients'}</span>
              <div className="tiny muted clamp">{sn.body}</div>
            </div>
            <button
              className="btn ghost sm danger"
              aria-label="Delete snippet"
              onClick={async () => {
                await api(`/snippets/${sn.id}`, { method: 'DELETE' });
                reload();
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      <form
        className="card-body stack"
        style={{ borderTop: '1px solid var(--line)' }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/snippets', { body: { ...form, clientId: form.clientId || null } });
            setForm({ name: '', body: '', clientId: form.clientId });
            reload();
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        }}
      >
        <div className="row">
          <input className="input" style={{ flex: 1, minWidth: 160 }} required placeholder="Name, e.g. Bakery hashtags" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="Snippet name" />
          <select className="input" style={{ width: 'auto' }} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} aria-label="Client">
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <textarea className="input" rows={2} required placeholder="#PuneFood #Bakery #FreshBread" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} aria-label="Snippet text" />
        <button className="btn" style={{ alignSelf: 'flex-start' }}>
          Save snippet
        </button>
      </form>
    </section>
  );
}
