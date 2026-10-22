import { Plus, RefreshCw, Rss, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { api } from '../lib/api';
import { fmt, ago } from '../lib/time';
import type { Channel, Client, Feed, Slot } from '../lib/types';
import { useApp } from './Layout';
import { Avatar, ErrorBanner, Modal, Spinner, useLoad, useToast } from './ui';

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
    <section className="card pad stack">
      <div className="row between">
        <h3>Posting times</h3>
        {data?.next && <span className="tiny muted">Next free: {fmt(data.next, client.timezone, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
      </div>
      <p className="small muted">Pick the times this client usually posts. "Add to queue" in the composer drops each post into the next free time, so you never have to pick dates.</p>
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
      <span className="tiny muted">Times are in {client.timezone.replace(/_/g, ' ')}. Click a time to remove it.</span>
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
