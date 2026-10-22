import { ExternalLink, Link2, Plus, RefreshCw, Rss, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { api } from '../lib/api';
import { fmt, ago } from '../lib/time';
import type { Channel, Client, Feed, Slot } from '../lib/types';
import { useApp } from './Layout';
import { Avatar, CopyField, ErrorBanner, Modal, Spinner, useLoad, useToast } from './ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Weekly posting times. "Add to queue" fills the next free one. */
export function PostingTimes({ client }: { client: Client }) {
  const toast = useToast();
  const { reloadClients } = useApp();
  const [slots, setSlots] = useState<Slot[]>(client.queueSlots ?? []);
  const [time, setTime] = useState('09:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const { data, reload } = useLoad(() => api<{ next: string | null; upcoming: { id: string; scheduledAt: string }[] }>(`/clients/${client.id}/queue`), [client.id]);
  const save = async (next: Slot[]) => {
    const r = await api<{ slots: Slot[] }>(`/clients/${client.id}/queue`, { method: 'PUT', body: { slots: next } });
    setSlots(r.slots);
    await reloadClients();
    reload();
  };
  return (
    <section className="card pad stack" id="posting-times">
      <div className="row between">
        <h3>Posting times</h3>
        {data?.next && <span className="tiny muted">Next free: {fmt(data.next, client.timezone, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
      </div>
      <p className="small muted">Pick the times this brand usually posts. "Add to queue" in the composer drops each post into the next free time, so you never have to pick dates.</p>
      <div className="slots">
        {ORDER.map((d) => (
          <div key={d} className="slot-day">
            <strong className="tiny">{DAYS[d]}</strong>
            {slots
              .filter((s) => s.day === d)
              .map((s) => (
                <button key={s.time} type="button" className="slot" title="Remove" onClick={() => save(slots.filter((x) => !(x.day === s.day && x.time === s.time)))}>
                  {s.time}
                </button>
              ))}
          </div>
        ))}
      </div>
      <div className="row small">
        Add
        <input className="input" type="time" style={{ width: 'auto' }} value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
        on
        <span className="row" style={{ gap: 4 }}>
          {ORDER.map((d) => (
            <button key={d} type="button" className={`tag ${days.includes(d) ? 'on' : ''}`} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])}>
              {DAYS[d]}
            </button>
          ))}
        </span>
        <button
          type="button"
          className="btn sm"
          disabled={!time || !days.length}
          onClick={async () => {
            await save([...slots, ...days.map((day) => ({ day, time }))]);
            toast('Posting times saved');
          }}
        >
          <Plus size={14} /> Add
        </button>
      </div>
      <div className="row between">
        <span className="tiny muted">Times are in {client.timezone.replace(/_/g, ' ')}. Click a time to remove it.</span>
        <SuggestTimes client={client} slots={slots} onAdd={(add) => save([...slots, ...add]).then(() => toast('Best times added'))} />
      </div>
    </section>
  );
}

/** RSS and Atom feeds that turn new articles into posts. */
export function Feeds({ client, channels }: { client: Client; channels: Channel[] }) {
  const toast = useToast();
  const { data, reload } = useLoad(() => api<{ feeds: Feed[] }>(`/feeds?client=${client.id}`), [client.id]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="row" style={{ gap: 6 }}>
          <Rss size={16} /> Feeds
        </h3>
        <button className="btn sm" onClick={() => setAdding(true)} disabled={!channels.length}>
          <Plus size={14} /> Add a feed
        </button>
      </div>
      <div className="card-body small muted">New articles from a blog, news site or YouTube channel become posts automatically. Only articles published after you add the feed are posted.</div>
      <div className="list">
        {data?.feeds.map((f) => (
          <div key={f.id} className="list-item" style={{ alignItems: 'center' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <strong className="small">{f.title || f.url}</strong>
              <div className="tiny muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.mode === 'queue' ? 'Adds to the queue' : f.mode === 'now' ? 'Posts right away' : 'Saves drafts'} · checked {ago(f.lastCheckedAt)}
                {f.lastItemAt && ` · last post ${ago(f.lastItemAt)}`}
              </div>
              {f.lastError && <div className="tiny" style={{ color: 'var(--error)' }}>{f.lastError}</div>}
            </div>
            <label className="check tiny">
              <input
                type="checkbox"
                checked={f.active}
                onChange={async (e) => {
                  await api(`/feeds/${f.id}`, { method: 'PATCH', body: { active: e.target.checked } });
                  reload();
                }}
              />{' '}
              On
            </label>
            <button
              className="btn ghost sm"
              aria-label="Check now"
              disabled={!!busy}
              onClick={async () => {
                setBusy(f.id);
                try {
                  const r = await api<{ created: number }>(`/feeds/${f.id}/check`, { method: 'POST' });
                  toast(r.created ? `${r.created} new post${r.created === 1 ? '' : 's'} created` : 'No new articles');
                  reload();
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === f.id ? <Spinner size={14} /> : <RefreshCw size={14} />}
            </button>
            <button
              className="btn ghost sm danger"
              aria-label="Remove feed"
              onClick={async () => {
                if (!confirm('Stop following this feed?')) return;
                await api(`/feeds/${f.id}`, { method: 'DELETE' });
                reload();
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      {adding && <AddFeed client={client} channels={channels} onClose={() => setAdding(false)} onDone={reload} />}
    </section>
  );
}

function AddFeed({ client, channels, onClose, onDone }: { client: Client; channels: Channel[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<{ title: string; items: { title: string; link: string }[] } | null>(null);
  const [selected, setSelected] = useState(channels.filter((c) => c.status !== 'disconnected').map((c) => c.id));
  const [template, setTemplate] = useState('{title}\n\n{link}');
  const [mode, setMode] = useState(client.queueSlots?.length ? 'queue' : 'draft');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add a feed"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || !preview || !selected.length}
          onClick={() =>
            run(async () => {
              await api('/feeds', { body: { clientId: client.id, url, channelIds: selected, template, mode } });
              toast('Feed added. New articles will become posts.');
              onDone();
              onClose();
            })
          }
        >
          {busy && <Spinner />} Add feed
        </button>
      }
    >
      <div className="stack">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => setPreview(await api('/feeds/preview', { body: { url } })));
          }}
        >
          <input className="input" style={{ flex: 1 }} type="url" required placeholder="https://blog.example.com/feed" value={url} onChange={(e) => (setUrl(e.target.value), setPreview(null))} aria-label="Feed address" />
          <button className="btn" disabled={busy}>
            {busy && !preview ? <Spinner /> : null} Check
          </button>
        </form>
        {preview && (
          <div className="extra small">
            <strong>{preview.title || 'Feed found'}</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {preview.items.slice(0, 3).map((i) => (
                <li key={i.link}>{i.title}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="stack" style={{ gap: 6 }}>
          <strong className="small">Post to</strong>
          <div className="channel-pick">
            {channels.map((c) => (
              <button key={c.id} type="button" className={selected.includes(c.id) ? 'on' : ''} onClick={() => setSelected(selected.includes(c.id) ? selected.filter((x) => x !== c.id) : [...selected, c.id])}>
                <Avatar src={c.avatarUrl} name={c.name} platform={c.platform} size={22} /> {c.name}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          Post text <span className="hint">Use {'{title}'}, {'{link}'} and {'{summary}'}.</span>
          <textarea className="input" rows={3} value={template} onChange={(e) => setTemplate(e.target.value)} />
        </label>
        <label className="field">
          New articles
          <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="queue" disabled={!client.queueSlots?.length}>
              Add to the queue{client.queueSlots?.length ? '' : ' (set posting times first)'}
            </option>
            <option value="draft">Save as drafts to review</option>
            <option value="now">Post right away</option>
          </select>
        </label>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}

type Best = { basis: 'general' | 'data'; measured: number; slots: { day: number; hour: number; time: string; score: number | null; posts: number }[] };

/** Fills posting times from when this client's audience responds best (or common good times, until there is data). */
function SuggestTimes({ client, slots, onAdd }: { client: Client; slots: Slot[]; onAdd: (s: Slot[]) => Promise<void> }) {
  const [best, setBest] = useState<Best | null>(null);
  const [busy, setBusy] = useState(false);
  const fresh = best?.slots.filter((b) => !slots.some((s) => s.day === b.day && s.time === b.time)) ?? [];
  if (!best)
    return (
      <button
        type="button"
        className="btn sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            setBest(await api<Best>(`/clients/${client.id}/best-times`));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner size={14} /> : <Sparkles size={14} />} Suggest best times
      </button>
    );
  return (
    <div className="extra small stack" style={{ gap: 6, width: '100%' }}>
      <span>
        {best.basis === 'data'
          ? `From ${best.measured} of ${client.name}'s posts, these times got the strongest response:`
          : `Not enough results yet (${best.measured} posts with numbers). These times usually work well:`}
      </span>
      <span className="row" style={{ gap: 4 }}>
        {best.slots.map((b) => (
          <span key={`${b.day}${b.time}`} className="tag on">
            {DAYS[b.day]} {b.time}
          </span>
        ))}
      </span>
      <span className="row" style={{ gap: 6 }}>
        <button type="button" className="btn sm primary" disabled={!fresh.length} onClick={() => onAdd(fresh.map((b) => ({ day: b.day, time: b.time }))).then(() => setBest(null))}>
          {fresh.length ? `Add ${fresh.length} to posting times` : 'Already added'}
        </button>
        <button type="button" className="btn sm ghost" onClick={() => setBest(null)}>
          Close
        </button>
      </span>
    </div>
  );
}

type LinkSettings = { track: boolean; utm: boolean; campaign: string };

/** Click tracking and UTM tags for every link this client posts. */
export function LinkTracking({ client }: { client: Client }) {
  const toast = useToast();
  const { data, reload } = useLoad(() => api<{ settings: LinkSettings; shortBase: string }>(`/clients/${client.id}/links`), [client.id]);
  const [campaign, setCampaign] = useState<string | null>(null);
  if (!data) return null;
  const s = data.settings;
  const save = async (next: Partial<LinkSettings>) => {
    await api(`/clients/${client.id}/links`, { method: 'PUT', body: { ...s, ...next } });
    reload();
    toast('Link settings saved');
  };
  return (
    <section className="card pad stack">
      <h3 className="row" style={{ gap: 6 }}>
        <Link2 size={16} /> Link tracking
      </h3>
      <label className="check small">
        <input type="checkbox" checked={s.track} onChange={(e) => save({ track: e.target.checked })} /> Count clicks with short links
      </label>
      <p className="tiny muted" style={{ margin: '-6px 0 0 24px' }}>
        Links in posts go out as {data.shortBase}abc1234, one per network, so you can see which posts and networks bring visitors. Previews still show the real page.
      </p>
      <label className="check small">
        <input type="checkbox" checked={s.utm} onChange={(e) => save({ utm: e.target.checked })} /> Add UTM tags for Google Analytics
      </label>
      {s.utm && (
        <form
          className="row small"
          style={{ marginLeft: 24 }}
          onSubmit={(e) => {
            e.preventDefault();
            save({ campaign: campaign ?? s.campaign });
          }}
        >
          Campaign
          <input className="input" style={{ width: 180 }} placeholder="surecast" value={campaign ?? s.campaign} onChange={(e) => setCampaign(e.target.value)} aria-label="UTM campaign" />
          <button className="btn sm">Save</button>
        </form>
      )}
      {s.utm && <span className="tiny muted" style={{ marginLeft: 24 }}>Adds utm_source (the network), utm_medium=social and utm_campaign. Links that already have UTM tags are left alone.</span>}
    </section>
  );
}

type Bio = { slug: string; title: string; bio: string; links: { label: string; url: string }[]; showPosts: boolean; accent: string; published: boolean; saved: boolean };

/** A link-in-bio page for Instagram and TikTok profiles. */
export function BioPage({ client }: { client: Client }) {
  const toast = useToast();
  const { data, reload } = useLoad(() => api<{ page: Bio }>(`/clients/${client.id}/bio`), [client.id]);
  const [form, setForm] = useState<Bio | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = form ?? data?.page;
  if (!f) return null;
  const set = (patch: Partial<Bio>) => setForm({ ...f, ...patch });
  const url = `${location.origin}/b/${data?.page.slug}`;
  return (
    <section className="card pad stack">
      <div className="row between">
        <h3>Link in bio</h3>
        {data?.page.saved && data.page.published && (
          <a className="small row" style={{ gap: 4 }} href={url} target="_blank" rel="noreferrer">
            Open page <ExternalLink size={13} />
          </a>
        )}
      </div>
      <p className="small muted">One page for the link in {client.name}'s Instagram or TikTok bio: their buttons plus their latest posts. Every click is counted in Analytics.</p>
      {data?.page.saved && data.page.published && <CopyField value={url} />}
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api(`/clients/${client.id}/bio`, { method: 'PUT', body: f });
            setForm(null);
            reload();
            toast('Bio page saved');
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          Address
          <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
            <span className="small muted" style={{ whiteSpace: 'nowrap' }}>
              {location.host}/b/
            </span>
            <input className="input" value={f.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase() })} />
          </span>
        </label>
        <label className="field">
          Title
          <input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} />
        </label>
        <label className="field">
          Short bio
          <textarea className="input" rows={2} value={f.bio} onChange={(e) => set({ bio: e.target.value })} maxLength={500} />
        </label>
        <div className="stack" style={{ gap: 6 }}>
          <strong className="small">Buttons</strong>
          {f.links.map((l, i) => (
            <div key={i} className="row" style={{ flexWrap: 'nowrap' }}>
              <input className="input" placeholder="Label" value={l.label} onChange={(e) => set({ links: f.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} aria-label={`Button ${i + 1} label`} />
              <input className="input" placeholder="https://" value={l.url} onChange={(e) => set({ links: f.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} aria-label={`Button ${i + 1} link`} />
              <button type="button" className="btn ghost sm" aria-label="Remove button" onClick={() => set({ links: f.links.filter((_, j) => j !== i) })}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => set({ links: [...f.links, { label: '', url: '' }] })} disabled={f.links.length >= 20}>
            <Plus size={14} /> Add a button
          </button>
        </div>
        <div className="row">
          <label className="check small">
            <input type="checkbox" checked={f.showPosts} onChange={(e) => set({ showPosts: e.target.checked })} /> Show latest posts
          </label>
          <label className="check small">
            <input type="checkbox" checked={f.published} onChange={(e) => set({ published: e.target.checked })} /> Page is live
          </label>
          <label className="row small" style={{ gap: 6 }}>
            Colour <input type="color" value={f.accent} onChange={(e) => set({ accent: e.target.value })} aria-label="Button colour" />
          </label>
        </div>
        <div className="bio-preview" aria-label="Preview">
          <strong>{f.title || client.name}</strong>
          {f.bio && <div className="tiny muted">{f.bio}</div>}
          {f.links
            .filter((l) => l.label)
            .map((l, i) => (
              <span key={i} className="bio-btn" style={{ background: f.accent }}>
                {l.label}
              </span>
            ))}
        </div>
        <ErrorBanner error={error} />
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy}>
          {busy && <Spinner />} {data?.page.saved ? 'Save page' : 'Create page'}
        </button>
      </form>
    </section>
  );
}
