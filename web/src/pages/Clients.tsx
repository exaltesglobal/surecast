import { AlertCircle, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { useApp } from '../components/Layout';
import { Empty, ErrorBanner, Modal, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { TIMEZONES } from '../lib/time';

const COLORS = ['#FF7A1A', '#1185FE', '#1E7A4C', '#C62828', '#6364FF', '#D62976', '#975A16', '#111827'];

export function ClientsPage() {
  const { clients, reloadClients, tz } = useApp();
  const [params, setParams] = useSearchParams();
  const showNew = params.get('new') === '1';
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Brands</h1>
          <p>Each brand has its own channels, time zone, approvals and reports.</p>
        </div>
        <button className="btn primary" onClick={() => setParams({ new: '1' })}>
          <Plus size={16} /> Add brand
        </button>
      </div>
      {clients.length ? (
        <div className="grid three">
          {clients.map((c) => (
            <Link key={c.id} to={`/clients/${c.id}`} className="card pad stack" style={{ color: 'inherit', textDecoration: 'none', opacity: c.archivedAt ? 0.6 : 1, borderTop: `4px solid ${c.color}` }}>
              <div className="row between">
                <h3>{c.name}</h3>
                {c.archivedAt && <span className="pill neutral">Archived</span>}
              </div>
              <span className="small muted">
                {c.channelCount} channel{c.channelCount === 1 ? '' : 's'} · {c.timezone.replace(/_/g, ' ')}
                {c.approvalRequired && ' · approvals on'}
              </span>
              {c.channelsAtRisk > 0 && (
                <span className="small row" style={{ gap: 6, color: 'var(--error)' }}>
                  <AlertCircle size={14} /> {c.channelsAtRisk} channel{c.channelsAtRisk === 1 ? ' needs' : 's need'} attention
                </span>
              )}
            </Link>
          ))}
        </div>
      ) : (
        <div className="card">
          <Empty title="No brands yet">Add your first brand to connect their channels.</Empty>
        </div>
      )}
      {showNew && <NewClient defaultTz={tz} onClose={() => setParams({})} onSaved={reloadClients} />}
    </>
  );
}

function NewClient({ onClose, onSaved, defaultTz }: { onClose: () => void; onSaved: () => Promise<void>; defaultTz: string }) {
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(defaultTz === 'UTC' ? Intl.DateTimeFormat().resolvedOptions().timeZone : defaultTz);
  const [color, setColor] = useState(COLORS[0]);
  const [approvalRequired, setApproval] = useState(false);
  const [contactEmail, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ id: string }>('/clients', { body: { name, timezone, color, approvalRequired, contactEmail: contactEmail || undefined } });
      await onSaved();
      nav(`/clients/${r.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Add a brand" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <label className="field">
          Name
          <input className="input" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Bakery" />
        </label>
        <label className="field">
          Time zone <span className="hint">Posts are scheduled in this time zone.</span>
          <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {TIMEZONES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <div className="field">
          Colour
          <div className="row">
            {COLORS.map((c) => (
              <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: 99, background: c, border: color === c ? '3px solid var(--text)' : '3px solid transparent', cursor: 'pointer' }} />
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={approvalRequired} onChange={(e) => setApproval(e.target.checked)} /> An approver signs off posts before they go out
        </label>
        {approvalRequired && (
          <label className="field">
            Approver's email <span className="hint">We email them a link to review posts. No account needed.</span>
            <input className="input" type="email" value={contactEmail} onChange={(e) => setContact(e.target.value)} />
          </label>
        )}
        <ErrorBanner error={error} />
        <button className="btn primary" disabled={busy}>
          {busy && <Spinner />} Add brand
        </button>
      </form>
    </Modal>
  );
}
