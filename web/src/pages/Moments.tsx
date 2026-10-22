import { CalendarHeart, Lightbulb, PenSquare, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useApp } from '../components/Layout';
import { Empty, ErrorBanner, Loading, Modal, Spinner, useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';

type Moment = { id: string; date: string; name: string; note: string; region: string; kind: string; approximate: boolean; clientId?: string | null; yearly?: boolean };
type Idea = { title: string; angle: string; format: string };

const REGIONS = [
  { id: 'global', label: 'Worldwide' },
  { id: 'in', label: 'India' },
  { id: 'us', label: 'US' },
  { id: 'uk', label: 'UK' },
  { id: 'custom', label: 'Our dates' },
];
const KIND: Record<string, string> = { holiday: 'Holiday', awareness: 'Awareness day', shopping: 'Shopping', fun: 'Fun', custom: 'Our date' };

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function MomentsPage() {
  const { clients } = useApp();
  const toast = useToast();
  const active = clients.filter((c) => !c.archivedAt);
  const [days, setDays] = useState(90);
  const [regions, setRegions] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('sc_moment_regions') ?? 'null') ?? ['global', 'in', 'custom'];
    } catch {
      return ['global', 'in', 'custom'];
    }
  });
  const from = iso(new Date());
  const to = iso(new Date(Date.now() + days * 86_400_000));
  const { data, error, loading, reload } = useLoad(() => api<{ moments: Moment[] }>(`/moments?from=${from}&to=${to}`), [days]);
  const [ideasFor, setIdeasFor] = useState<Moment | null>(null);
  const [adding, setAdding] = useState(false);

  const toggle = (r: string) => {
    const next = regions.includes(r) ? regions.filter((x) => x !== r) : [...regions, r];
    setRegions(next);
    try {
      localStorage.setItem('sc_moment_regions', JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const shown = (data?.moments ?? []).filter((m) => regions.includes(m.region));
  const byDate = new Map<string, Moment[]>();
  for (const m of shown) byDate.set(m.date, [...(byDate.get(m.date) ?? []), m]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Moments</h1>
          <p>Days worth posting about, with ideas for each client. Plan them a few weeks ahead.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Plus size={16} /> Add a date
        </button>
      </div>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div className="chips">
          {REGIONS.map((r) => (
            <label key={r.id} className="check small chip" style={{ paddingRight: 10 }}>
              <input type="checkbox" checked={regions.includes(r.id)} onChange={() => toggle(r.id)} /> {r.label}
            </label>
          ))}
        </div>
        <div className="seg">
          {[30, 90, 180, 365].map((d) => (
            <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>
              {d === 365 ? '1 year' : `${d} days`}
            </button>
          ))}
        </div>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : !byDate.size ? (
        <Empty title="Nothing in this period" icon={<CalendarHeart />}>
          Show more regions or a longer period, or add your own dates.
        </Empty>
      ) : (
        <section className="card">
          {[...byDate].map(([date, list]) => {
            const d = new Date(`${date}T00:00:00Z`);
            const until = Math.round((d.getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);
            return (
              <div key={date} className="moment-day">
                <div className="moment-date">
                  <span>{d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}</span>
                  <strong>{d.getUTCDate()}</strong>
                  <span>{d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</span>
                </div>
                <div className="stack" style={{ gap: 10 }}>
                  {list.map((m) => (
                    <div key={`${m.id}-${date}`} className="row between" style={{ alignItems: 'flex-start' }}>
                      <div className="grow">
                        <strong>{m.name}</strong>{' '}
                        <span className="tiny muted">
                          {KIND[m.kind]} · {REGIONS.find((r) => r.id === m.region)?.label}
                          {m.approximate && ' · date approximate'}
                          {m.clientId && ` · ${clients.find((c) => c.id === m.clientId)?.name ?? ''}`}
                          {until === 0 ? ' · today' : until === 1 ? ' · tomorrow' : ` · in ${until} days`}
                        </span>
                        {m.note && <div className="tiny muted">{m.note}</div>}
                      </div>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <button className="btn sm" onClick={() => setIdeasFor(m)}>
                          <Lightbulb size={14} /> Ideas
                        </button>
                        <Link className="btn sm" to={`/posts/new?date=${date}${m.clientId ? `&client=${m.clientId}` : ''}`}>
                          <PenSquare size={14} /> Write
                        </Link>
                        {m.region === 'custom' && (
                          <button
                            className="btn ghost sm danger"
                            aria-label="Remove date"
                            onClick={async () => {
                              if (!confirm(`Remove "${m.name}"?`)) return;
                              await api(`/moments/${m.id}`, { method: 'DELETE' });
                              toast('Removed');
                              reload();
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
      )}
      {ideasFor && <IdeasModal moment={ideasFor} onClose={() => setIdeasFor(null)} clients={active} />}
      {adding && <AddMoment clients={active} onClose={() => setAdding(false)} onDone={() => (setAdding(false), reload())} />}
    </>
  );
}

function IdeasModal({ moment, onClose, clients }: { moment: Moment; onClose: () => void; clients: { id: string; name: string }[] }) {
  const [clientId, setClientId] = useState(moment.clientId ?? clients[0]?.id ?? '');
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const get = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ ideas: Idea[] }>('/ai/ideas', {
        body: { clientId, count: 6, topic: `${moment.name} on ${moment.date}${moment.note ? ` (${moment.note})` : ''}. Ideas that fit this client naturally; skip a forced tie-in.` },
      });
      setIdeas(r.ideas);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Ideas for ${moment.name}`} onClose={onClose}>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <select className="input" value={clientId} onChange={(e) => (setClientId(e.target.value), setIdeas(null))} aria-label="Client">
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={busy || !clientId} onClick={get}>
          {busy ? <Spinner size={13} /> : <Lightbulb size={14} />} {ideas ? 'More ideas' : 'Get ideas'}
        </button>
      </div>
      <ErrorBanner error={error} />
      {ideas?.map((i) => (
        <div key={i.title} className="card pad stack" style={{ gap: 4, boxShadow: 'none' }}>
          <strong className="small">{i.title}</strong>
          <span className="small muted">{i.angle}</span>
          <Link className="tiny" to={`/posts/new?client=${clientId}&date=${moment.date}&text=${encodeURIComponent(`${i.title}\n\n${i.angle}`)}`}>
            Start a post from this
          </Link>
        </div>
      ))}
    </Modal>
  );
}

function AddMoment({ clients, onClose, onDone }: { clients: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ date: '', name: '', note: '', clientId: '', yearly: true });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title="Add a date"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            try {
              await api('/moments', { body: { ...form, clientId: form.clientId || null } });
              onDone();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Add
        </button>
      }
    >
      <label className="field">
        Name
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Bakery's 5th birthday" autoFocus />
      </label>
      <label className="field">
        Date
        <input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
      </label>
      <label className="field">
        Client <span className="hint">Optional</span>
        <select className="input" value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}>
          <option value="">Every client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Note <span className="hint">Optional</span>
        <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={form.yearly} onChange={(e) => setForm({ ...form, yearly: e.target.checked })} /> Every year
      </label>
      <ErrorBanner error={error} />
    </Modal>
  );
}
