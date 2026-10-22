// Client tools added in wave 6: the emergency brake, the brand safety guard, WhatsApp and the
// weekly digest, and turning a link into a campaign.
import { Link2, MessageCircle, OctagonPause, Play, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { api } from '../lib/api';
import { fmt } from '../lib/time';
import type { Channel, Client, Guard, MissedMode } from '../lib/types';
import { useApp } from './Layout';
import { ErrorBanner, Modal, PlatformBadge, Spinner, useLoad, useToast } from './ui';

const MISSED: { id: MissedMode; label: string; help: string }[] = [
  { id: 'skip', label: 'Skip them', help: 'Posts whose time passed are cancelled. Nothing old goes out.' },
  { id: 'post_now', label: 'Post them now', help: 'Everything that was held goes out straight away.' },
  { id: 'queue', label: 'Move to the queue', help: 'Each missed post takes the next free posting time.' },
];

function MissedChoice({ value, onChange }: { value: MissedMode; onChange: (m: MissedMode) => void }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      {MISSED.map((m) => (
        <label key={m.id} className="check" style={{ alignItems: 'flex-start' }}>
          <input type="radio" name="missed" checked={value === m.id} onChange={() => onChange(m.id)} style={{ marginTop: 3 }} />
          <span>
            <strong>{m.label}</strong>
            <span className="tiny muted" style={{ display: 'block' }}>
              {m.help}
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}

/** The red button: hold everything for this client, now, on every network. */
export function EmergencyBrake({ client, as }: { client: Client; as: 'button' | 'banner' }) {
  const { reloadClients } = useApp();
  const toast = useToast();
  const [open, setOpen] = useState<'pause' | 'resume' | null>(null);
  const [reason, setReason] = useState('');
  const [until, setUntil] = useState('');
  const [missed, setMissed] = useState<MissedMode>(client.paused?.missed ?? 'skip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (open === 'pause') {
        const r = await api<{ held: number }>(`/clients/${client.id}/pause`, { body: { reason, until: until ? new Date(until).toISOString() : null, missed } });
        toast(`Paused. ${r.held} post${r.held === 1 ? '' : 's'} held.`);
      } else {
        const r = await api<{ resumed: number; skipped: number; postedNow: number; queued: number }>(`/clients/${client.id}/resume`, { body: { missed } });
        toast(`Resumed: ${r.resumed} kept their time${r.skipped ? `, ${r.skipped} skipped` : ''}${r.postedNow ? `, ${r.postedNow} posting now` : ''}${r.queued ? `, ${r.queued} queued` : ''}.`);
      }
      await reloadClients();
      setOpen(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {as === 'banner' && client.paused ? (
        <div className="banner paused" style={{ marginBottom: 16 }}>
          <OctagonPause size={20} style={{ flex: 'none' }} />
          <div className="body">
            <strong>Publishing for {client.name} is paused</strong>
            <p>
              {client.paused.reason ? `${client.paused.reason} · ` : ''}Paused by {client.paused.by} {fmt(client.paused.at)}.{' '}
              {client.paused.until ? `Resumes by itself ${fmt(client.paused.until)}.` : 'Nothing goes out until someone resumes it.'}
            </p>
          </div>
          <button className="btn sm primary" onClick={() => setOpen('resume')}>
            <Play size={14} /> Resume
          </button>
        </div>
      ) : null}
      {as === 'button' && !client.paused && (
        <button className="btn brake-btn" onClick={() => setOpen('pause')} title="Hold every unsent post for this brand">
          <OctagonPause size={16} /> Pause all posting
        </button>
      )}
      {open && (
        <Modal
          title={open === 'pause' ? `Pause all posting for ${client.name}` : `Resume posting for ${client.name}`}
          onClose={() => setOpen(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setOpen(null)}>
                Cancel
              </button>
              <button className={`btn ${open === 'pause' ? 'danger-solid' : 'primary'}`} disabled={busy} onClick={submit}>
                {busy && <Spinner size={13} />} {open === 'pause' ? 'Pause now' : 'Resume'}
              </button>
            </>
          }
        >
          {open === 'pause' ? (
            <>
              <p className="small muted" style={{ margin: 0 }}>
                Every post that has not gone out yet is held, on every network, straight away. New posts for this brand are held too. Nothing is deleted.
              </p>
              <label className="field">
                Reason <span className="hint">The team sees this. For example: a recall, a bereavement, an unpaid invoice.</span>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              </label>
              <label className="field">
                Resume by itself <span className="hint">Optional. Leave empty to resume by hand.</span>
                <input className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
              </label>
              <strong className="small">When it resumes, posts whose time passed:</strong>
            </>
          ) : (
            <>
              <p className="small muted" style={{ margin: 0 }}>Posts whose time is still ahead keep it. For posts whose time passed while paused:</p>
            </>
          )}
          <MissedChoice value={missed} onChange={setMissed} />
          <ErrorBanner error={error} />
        </Modal>
      )}
    </>
  );
}

function ChipInput({ label, hint, values, onChange, placeholder }: { label: string; hint: string; values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...values, v]);
    setDraft('');
  };
  return (
    <label className="field">
      {label} <span className="hint">{hint}</span>
      <div className="chips">
        {values.map((v) => (
          <span key={v} className="chip">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <input
        className="input"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </label>
  );
}

/** Words a client never allows and lines they always need, checked on every post. */
export function BrandGuard({ client }: { client: Client }) {
  const { reloadClients } = useApp();
  const toast = useToast();
  const [guard, setGuard] = useState<Guard>(client.guard);
  const [test, setTest] = useState('');
  const [result, setResult] = useState<{ ok: boolean; issues: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api(`/clients/${client.id}`, { method: 'PATCH', body: { guard } });
      await reloadClients();
      setError(null);
      toast('Brand guard saved');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card pad stack">
      <div className="row" style={{ gap: 8 }}>
        <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
        <h3 style={{ margin: 0 }}>Brand safety guard</h3>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Checked on every post for {client.name}, by everyone on the team and every AI agent, before it is scheduled and again just before it goes out.
      </p>
      <ChipInput label="Never allowed" hint="Competitors, banned claims, words to avoid. Whole words only." values={guard.banned} onChange={(banned) => setGuard({ ...guard, banned })} placeholder="Type a word and press Enter" />
      <ChipInput label="Always needed" hint="For example #ad, a licence number or a regulator's warning." values={guard.required} onChange={(required) => setGuard({ ...guard, required })} placeholder="Type a line and press Enter" />
      <div className="seg" role="radiogroup" aria-label="When a post breaks a rule">
        <button type="button" className={guard.mode === 'warn' ? 'on' : ''} onClick={() => setGuard({ ...guard, mode: 'warn' })}>
          Warn
        </button>
        <button type="button" className={guard.mode === 'block' ? 'on' : ''} onClick={() => setGuard({ ...guard, mode: 'block' })}>
          Block
        </button>
      </div>
      <p className="tiny muted" style={{ margin: 0 }}>
        {guard.mode === 'block' ? 'A post that breaks a rule cannot be scheduled, and is stopped at publish time.' : 'Posts that break a rule show a warning but can still go out.'}
      </p>
      <label className="field">
        Try it
        <textarea className="input" rows={2} value={test} onChange={(e) => setTest(e.target.value)} placeholder="Paste a post to check it" />
      </label>
      {result && (
        <div className={`banner ${result.ok ? 'success' : 'warning'}`}>
          <div className="body">{result.ok ? 'This post follows the rules.' : result.issues.join(' ')}</div>
        </div>
      )}
      <ErrorBanner error={error} />
      <div className="row">
        <button className="btn primary" type="button" onClick={save}>
          Save guard
        </button>
        <button
          className="btn"
          type="button"
          disabled={!test.trim()}
          onClick={async () => setResult(await api<{ ok: boolean; issues: string[] }>('/guard/check', { body: { clientId: client.id, text: test, guard } }))}
        >
          Check
        </button>
      </div>
    </section>
  );
}

type Integration = { id: string; account: string; status: string; lastError: string | null; inbox: boolean; clientId: string | null };

/** WhatsApp approvals, WhatsApp chats in the inbox, and the weekly digest email. */
export function ClientWhatsApp({ client }: { client: Client }) {
  const { reloadClients } = useApp();
  const toast = useToast();
  const { data, reload } = useLoad(() => api<{ agency: Integration | null; clients: Integration[] }>('/integrations/chitthi'));
  const [phone, setPhone] = useState(client.whatsappPhone ?? '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mine = data?.clients.find((c) => c.clientId === client.id) ?? null;
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card pad stack">
      <div className="row" style={{ gap: 8 }}>
        <MessageCircle size={18} style={{ color: '#25d366' }} />
        <h3 style={{ margin: 0 }}>WhatsApp and weekly digest</h3>
      </div>
      <label className="field">
        Approver's WhatsApp number{' '}
        <span className="hint">
          {data?.agency ? 'Approval requests go here as well as by email.' : (
            <>
              Approval requests go here once you connect Chitthi in <Link to="/settings#whatsapp">Settings</Link>.
            </>
          )}
        </span>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" />
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              act('phone', async () => {
                await api(`/clients/${client.id}`, { method: 'PATCH', body: { whatsappPhone: phone.trim() || null } });
                await reloadClients();
                toast('Saved');
              })
            }
          >
            Save
          </button>
        </div>
      </label>
      <div className="stack" style={{ gap: 6 }}>
        <strong className="small">Their WhatsApp chats in your inbox</strong>
        {mine ? (
          <div className="row between">
            <span className="small">
              <PlatformBadge platform="whatsapp" size={18} /> Connected to <strong>{mine.account}</strong>
              {mine.lastError && <span className="tiny" style={{ color: 'var(--error)', display: 'block' }}>{mine.lastError}</span>}
            </span>
            <button
              className="btn ghost sm danger"
              onClick={() =>
                act('off', async () => {
                  if (!confirm('Stop bringing their WhatsApp chats into the inbox?')) return;
                  await api(`/integrations/chitthi?client=${client.id}`, { method: 'DELETE' });
                  await reload();
                })
              }
            >
              Disconnect
            </button>
          </div>
        ) : (
          <>
            <span className="tiny muted">
              If {client.name} uses Chitthi for WhatsApp, paste their Chitthi API key. New messages appear in your inbox, with AI reply suggestions, and your replies go out from their number.
            </span>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="chk_live_..." />
              <button
                className="btn"
                disabled={!key.trim() || !!busy}
                onClick={() =>
                  act('connect', async () => {
                    await api('/integrations/chitthi', { body: { apiKey: key.trim(), clientId: client.id } });
                    setKey('');
                    await reload();
                    toast('WhatsApp connected');
                  })
                }
              >
                {busy === 'connect' && <Spinner size={13} />} Connect
              </button>
            </div>
          </>
        )}
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={client.digestEnabled}
          disabled={!client.contactEmail}
          onChange={(e) =>
            act('digest', async () => {
              await api(`/clients/${client.id}`, { method: 'PATCH', body: { digestEnabled: e.target.checked } });
              await reloadClients();
            })
          }
        />
        Email {client.contactEmail ?? 'the approver'} a summary every Monday morning
      </label>
      {!client.contactEmail && <span className="tiny muted">Add the approver's email in Settings first.</span>}
      {client.contactEmail && (
        <button
          className="btn sm"
          style={{ alignSelf: 'flex-start' }}
          disabled={!!busy}
          onClick={() =>
            act('test', async () => {
              const r = await api<{ sentTo: string }>(`/clients/${client.id}/digest/test`, { method: 'POST' });
              toast(`Preview sent to ${r.sentTo}`);
            })
          }
        >
          Send me a preview
        </button>
      )}
      <ErrorBanner error={error} />
    </section>
  );
}

type CampaignResult = { name: string; source: { url: string; title: string }; posts: { id: string; angle: string; text: string; status: string; fits: boolean; note: string | null }[] };

/** Paste a link, get a week of posts about it. */
export function CampaignFromLink({ client, channels }: { client: Client; channels: Channel[] }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [goal, setGoal] = useState('');
  const [count, setCount] = useState(5);
  const [mode, setMode] = useState<'draft' | 'queue'>('draft');
  const usable = channels.filter((c) => c.status !== 'disconnected');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CampaignResult | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<CampaignResult>('/ai/campaign', { body: { clientId: client.id, url, goal, count, mode, channelIds: selected } });
      setResult(r);
      toast(`${r.posts.length} posts created`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn" onClick={() => (setOpen(true), setResult(null), setSelected(usable.map((c) => c.id)))}>
        <Link2 size={16} /> Campaign from a link
      </button>
      {open && (
        <Modal
          title={result ? result.name : 'Campaign from a link'}
          onClose={() => setOpen(false)}
          footer={
            result ? (
              <Link to={`/posts?client=${client.id}`} className="btn primary">
                See the posts
              </Link>
            ) : (
              <button className="btn primary" disabled={busy || !url.trim()} onClick={run}>
                {busy ? <Spinner size={13} /> : <Sparkles size={14} />} {busy ? 'Reading the page and writing…' : 'Write the campaign'}
              </button>
            )
          }
        >
          {result ? (
            <div className="stack">
              <span className="small muted">From {result.source.title || result.source.url}</span>
              {result.posts.map((p, i) => (
                <div key={p.id} className="card pad stack" style={{ gap: 6, boxShadow: 'none' }}>
                  <div className="row between">
                    <strong className="small">
                      {i + 1}. {p.angle}
                    </strong>
                    <span className={`pill ${p.status === 'queued' ? 'scheduled' : 'draft'}`}>{p.status === 'queued' ? 'Queued' : 'Draft'}</span>
                  </div>
                  <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                    {p.text}
                  </div>
                  {p.note && <span className="tiny" style={{ color: 'var(--warning)' }}>{p.note}</span>}
                  <Link to={`/posts/${p.id}/edit`} className="tiny">
                    Edit
                  </Link>
                </div>
              ))}
            </div>
          ) : (
            <>
              <p className="small muted" style={{ margin: 0 }}>
                Paste a product, article or event page. The assistant reads it and writes a run of posts in {client.name}'s voice, each from a different angle, using only facts from the page.
              </p>
              <label className="field">
                Link
                <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://acmebakery.in/pumpkin-croissant" autoFocus />
              </label>
              <label className="field">
                Goal <span className="hint">Optional</span>
                <input className="input" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Pre-orders before Diwali" />
              </label>
              <label className="field">
                Number of posts
                <input className="input" type="number" min={2} max={14} value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: 100 }} />
              </label>
              <div className="stack" style={{ gap: 6 }}>
                <strong className="small">Channels</strong>
                <div className="row">
                  {usable.map((c) => (
                    <label key={c.id} className="check small">
                      <input type="checkbox" checked={selected.includes(c.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
                      <PlatformBadge platform={c.platform} size={16} /> {c.name}
                    </label>
                  ))}
                  {!usable.length && <span className="tiny muted">No connected channels yet: the posts are saved as drafts.</span>}
                </div>
              </div>
              <div className="seg">
                <button type="button" className={mode === 'draft' ? 'on' : ''} onClick={() => setMode('draft')}>
                  Save as drafts
                </button>
                <button type="button" className={mode === 'queue' ? 'on' : ''} onClick={() => setMode('queue')} disabled={!client.queueSlots.length}>
                  Add to the queue
                </button>
              </div>
              {!client.queueSlots.length && <span className="tiny muted">Set posting times for {client.name} to queue posts straight away.</span>}
            </>
          )}
          <ErrorBanner error={error} />
        </Modal>
      )}
    </>
  );
}
