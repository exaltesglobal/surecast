import { FileBarChart, Lock, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { BioPage, Feeds, LinkTracking, PostingTimes } from '../components/ClientExtras';
import { BrandGuard, CampaignFromLink, ClientWhatsApp, EmergencyBrake } from '../components/ClientSafety';
import { useApp } from '../components/Layout';
import { Avatar, CopyField, Empty, ErrorBanner, Loading, Modal, Pill, PlatformBadge, Spinner, useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';
import { platformInfo } from '../lib/platforms';
import { ago, fmt, TIMEZONES } from '../lib/time';
import type { Channel, PlatformDef, Voice } from '../lib/types';

export function ClientPage() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const { clients, reloadClients } = useApp();
  const client = clients.find((c) => c.id === id);
  const { data, reload } = useLoad(() => api<{ channels: Channel[] }>(`/channels?client=${id}`), [id]);
  const platforms = useLoad(() => api<{ platforms: PlatformDef[] }>('/platforms'));
  const [connecting, setConnecting] = useState<PlatformDef | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (params.get('connected')) {
      toast('Channel connected');
      reloadClients();
      setParams({}, { replace: true });
    } else if (params.get('error')) {
      toast(params.get('error')!, 'error');
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!client) return <Loading />;
  const portal = `${location.origin}/c/${client.shareToken}`;
  const report = `${location.origin}/r/${client.shareToken}`;

  const check = async (ch: Channel) => {
    setBusy(ch.id);
    try {
      const r = await api<{ ok: boolean; message?: string }>(`/channels/${ch.id}/check`, { method: 'POST' });
      toast(r.ok ? 'Connection is working' : (r.message ?? 'Check failed'), r.ok ? 'ok' : 'error');
      await reload();
      reloadClients();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <span className="client-dot" style={{ background: client.color, width: 14, height: 14 }} />
            <h1>{client.name}</h1>
          </div>
          <p>
            {client.timezone.replace(/_/g, ' ')} · {client.approvalRequired ? 'Needs approval' : 'No approval step'}
          </p>
        </div>
        <div className="row">
          <EmergencyBrake client={client} as="button" />
          <CampaignFromLink client={client} channels={data?.channels ?? []} />
          <Link to={`/clients/${client.id}/report`} className="btn">
            <FileBarChart size={16} /> Proof-of-publish report
          </Link>
          <Link to={`/posts/new?client=${client.id}`} className="btn primary">
            New post
          </Link>
        </div>
      </div>

      <EmergencyBrake client={client} as="banner" />
      <div className="grid two" style={{ alignItems: 'start' }}>
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h2>Channels</h2>
            </div>
            {data?.channels.length ? (
              <div className="list">
                {data.channels.map((ch) => (
                  <div key={ch.id} className="list-item" style={{ alignItems: 'center' }}>
                    <Avatar src={ch.avatarUrl} name={ch.name} platform={ch.platform} size={36} />
                    <div className="grow">
                      <strong>{ch.name}</strong>
                      <div className="tiny muted">
                        {platformInfo(ch.platform).label} {ch.handle} · checked {ago(ch.lastCheckedAt)}
                        {ch.tokenExpiresAt && ` · expires ${fmt(ch.tokenExpiresAt, undefined, { dateStyle: 'medium' })}`}
                      </div>
                      {ch.statusDetail && ch.status !== 'ok' && (
                        <div className="tiny" style={{ color: ch.status === 'disconnected' ? 'var(--error)' : 'var(--warning)' }}>
                          {ch.statusDetail}
                        </div>
                      )}
                    </div>
                    <Pill status={ch.status} />
                    {ch.status !== 'ok' && platforms.data && (
                      <button className="btn sm accent" onClick={() => setConnecting(platforms.data!.platforms.find((p) => p.platform === ch.platform)!)}>
                        Reconnect
                      </button>
                    )}
                    <button className="btn ghost sm" disabled={busy === ch.id} onClick={() => check(ch)} title="Check connection" aria-label="Check connection">
                      {busy === ch.id ? <Spinner /> : <RefreshCw size={15} />}
                    </button>
                    <button
                      className="btn ghost sm danger"
                      title="Remove channel"
                      aria-label="Remove channel"
                      onClick={async () => {
                        if (!confirm(`Remove ${ch.name}? Posts scheduled for it will be cancelled.`)) return;
                        await api(`/channels/${ch.id}`, { method: 'DELETE' });
                        toast('Channel removed');
                        reload();
                        reloadClients();
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No channels yet">Connect one below.</Empty>
            )}
            <div className="card-body" style={{ borderTop: '1px solid var(--line)' }}>
              <strong className="small">Connect a channel</strong>
              <div className="row" style={{ marginTop: 10 }}>
                {platforms.data?.platforms.map((p) => (
                  <button key={p.platform} className="btn sm" onClick={() => setConnecting(p)} title={p.available ? '' : (p.unavailableReason ?? '')} style={{ opacity: p.available ? 1 : 0.6 }}>
                    <PlatformBadge platform={p.platform} size={18} /> {p.label} {!p.available && <Lock size={12} />}
                  </button>
                ))}
              </div>
            </div>
          </section>
          <Feeds client={client} channels={data?.channels ?? []} />
          <BioPage client={client} />
        </div>

        <div className="stack">
          <section className="card pad stack">
            <h3>Share outside your team</h3>
            <p className="small muted">These links need no login. Anyone with them can see this brand's posts, so share them only with people you trust.</p>
            <label className="field">
              Approval portal
              <CopyField value={portal} />
            </label>
            <label className="field">
              Live proof-of-publish report
              <CopyField value={report} />
            </label>
            <button
              className="btn sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                if (!confirm('Make new links? The old ones stop working.')) return;
                await api(`/clients/${client.id}/rotate-link`, { method: 'POST' });
                await reloadClients();
                toast('New links created');
              }}
            >
              Replace links
            </button>
          </section>
          <PostingTimes client={client} />
          <LinkTracking client={client} />
          <ClientSettings />
          <BrandGuard client={client} />
          <ClientWhatsApp client={client} />
          <BrandVoice />
        </div>
      </div>
      {connecting && <ConnectModal platform={connecting} clientId={client.id} onClose={() => setConnecting(null)} onDone={() => (reload(), reloadClients())} />}
    </>
  );
}

function ClientSettings() {
  const { id } = useParams();
  const toast = useToast();
  const { clients, reloadClients } = useApp();
  const c = clients.find((x) => x.id === id)!;
  const [form, setForm] = useState({ name: c.name, timezone: c.timezone, approvalRequired: c.approvalRequired, contactEmail: c.contactEmail ?? '' });
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/clients/${c.id}`, { method: 'PATCH', body: { ...form, contactEmail: form.contactEmail || null } });
      await reloadClients();
      setError(null);
      toast('Saved');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="card pad stack" onSubmit={save}>
      <h3>Settings</h3>
      <label className="field">
        Name
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label className="field">
        Time zone
        <select className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
          {TIMEZONES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={form.approvalRequired} onChange={(e) => setForm({ ...form, approvalRequired: e.target.checked })} /> Posts need an approver's sign-off before they go out
      </label>
      <label className="field">
        Approver's email <span className="hint">For approval requests.</span>
        <input className="input" type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
      </label>
      <ErrorBanner error={error} />
      <div className="row between">
        <button className="btn primary">Save</button>
        <button
          type="button"
          className="btn ghost sm"
          onClick={async () => {
            await api(`/clients/${c.id}`, { method: 'PATCH', body: { archived: !c.archivedAt } });
            await reloadClients();
          }}
        >
          {c.archivedAt ? 'Restore brand' : 'Archive brand'}
        </button>
      </div>
    </form>
  );
}

const NO_VOICE: Voice = { description: '', audience: '', dos: '', donts: '', examples: '', language: '' };

/** How this client sounds. The writing assistant follows it for every post. */
function BrandVoice() {
  const { id } = useParams();
  const toast = useToast();
  const { clients, reloadClients } = useApp();
  const c = clients.find((x) => x.id === id)!;
  const [voice, setVoice] = useState<Voice>(c.voice ?? NO_VOICE);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Voice) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setVoice({ ...voice, [k]: e.target.value });
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <form
      className="card pad stack"
      onSubmit={(e) => {
        e.preventDefault();
        act('save', async () => {
          await api(`/clients/${c.id}`, { method: 'PATCH', body: { voice } });
          await reloadClients();
          toast('Brand voice saved');
        });
      }}
    >
      <div className="row between">
        <h3>Brand voice</h3>
        <button
          type="button"
          className="btn sm"
          disabled={!!busy}
          onClick={() =>
            act('learn', async () => {
              const r = await api<{ voice: Voice }>('/ai/learn-voice', { body: { clientId: c.id } });
              setVoice(r.voice);
              toast('Drafted from past posts. Check it, then save.');
            })
          }
        >
          {busy === 'learn' ? <Spinner size={13} /> : <Sparkles size={14} />} Learn from past posts
        </button>
      </div>
      <p className="small muted">The writing assistant follows this for every post it writes for {c.name}.</p>
      <label className="field">
        How they sound
        <textarea className="input" rows={2} value={voice.description} onChange={set('description')} placeholder="Warm, neighbourly and a little playful. Short sentences." />
      </label>
      <label className="field">
        Who they talk to
        <input className="input" value={voice.audience} onChange={set('audience')} placeholder="Families and office workers in Koregaon Park" />
      </label>
      <div className="voice-grid">
        <label className="field">
          Always
          <textarea className="input" rows={2} value={voice.dos} onChange={set('dos')} placeholder="Mention the neighbourhood. Sign off with 🥐" />
        </label>
        <label className="field">
          Never
          <textarea className="input" rows={2} value={voice.donts} onChange={set('donts')} placeholder="No discounts unless we say so. Don't say 'artisanal'." />
        </label>
      </div>
      <label className="field">
        Example posts <span className="hint">A few posts that sound just right, separated by ---</span>
        <textarea className="input" rows={4} value={voice.examples} onChange={set('examples')} />
      </label>
      <label className="field">
        Language
        <input className="input" value={voice.language} onChange={set('language')} placeholder="English (India)" />
      </label>
      <ErrorBanner error={error} />
      <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={!!busy}>
        {busy === 'save' && <Spinner size={13} />} Save brand voice
      </button>
    </form>
  );
}

function ConnectModal({ platform, clientId, onClose, onDone }: { platform: PlatformDef; clientId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ redirect?: string; channelId?: string; reconnected?: boolean }>('/channels/connect', { body: { clientId, platform: platform.platform, values } });
      if (r.redirect) {
        window.location.href = r.redirect;
        return;
      }
      toast(r.reconnected ? 'Reconnected. Waiting posts will go out now.' : 'Channel connected');
      onDone();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={`Connect ${platform.label}`} onClose={onClose}>
      {!platform.available ? (
        <div className="banner warning">
          <Lock size={18} />
          <div className="body">
            <strong>Not switched on yet</strong>
            <p>{platform.unavailableReason}</p>
          </div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="muted small">{platform.connect.help}</p>
          {platform.connect.fields.map((f) => (
            <label key={f.name} className="field">
              {f.label}
              <input
                className="input"
                type={f.type === 'password' ? 'password' : 'text'}
                placeholder={f.placeholder}
                required={f.required}
                value={values[f.name] ?? ''}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                autoComplete="off"
              />
              {f.help && <span className="hint">{f.help}</span>}
            </label>
          ))}
          <ErrorBanner error={error} />
          <button className="btn primary" disabled={busy}>
            {busy ? <Spinner /> : <Plus size={16} />} {platform.connect.kind === 'oauth' ? `Continue to ${platform.label}` : 'Connect'}
          </button>
        </form>
      )}
    </Modal>
  );
}
