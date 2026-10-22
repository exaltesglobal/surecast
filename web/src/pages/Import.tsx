import { AlertCircle, CheckCircle2, Download, FileUp } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useApp } from '../components/Layout';
import { Empty, ErrorBanner, Spinner, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmt } from '../lib/time';

type Row = { row: number; text: string; scheduledAt: string | null; channelNames: string[]; images: string[]; firstComment: string; issues: string[]; when: 'scheduled' | 'queue' | 'draft' };

const TEMPLATE = `date,time,text,channels,image_url,first_comment
2026-11-05,09:30,"Fresh pumpkin croissants are back! 🎃",all,https://example.com/croissant.jpg,
2026-11-06,18:00,"Weekend hours: 8am to 4pm. See you there!","bluesky,mastodon",,
,,"No date: goes into the next free posting time (or drafts)",all,,"More at https://example.com"
`;

export function ImportPage() {
  const { clients } = useApp();
  const toast = useToast();
  const active = clients.filter((c) => !c.archivedAt);
  const [clientId, setClientId] = useState(active.length === 1 ? active[0].id : '');
  const [csv, setCsv] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; results: { row: number; ok: boolean; error?: string }[] } | null>(null);
  const client = clients.find((c) => c.id === clientId);

  const run = async (name: string, fn: () => Promise<void>) => {
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
  const good = rows?.filter((r) => !r.issues.length).length ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Import posts</h1>
          <p>Schedule a month of posts from a spreadsheet. Every row is checked before anything is saved.</p>
        </div>
        <a
          className="btn"
          href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}
          download="surecast-import-template.csv"
        >
          <Download size={15} /> Template
        </a>
      </div>
      <div className="card pad stack">
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={clientId} onChange={(e) => (setClientId(e.target.value), setRows(null))} aria-label="Client">
            <option value="">Choose a client…</option>
            {active.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="btn">
            <FileUp size={15} /> Choose CSV file
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setCsv(await f.text());
                  setRows(null);
                }
              }}
            />
          </label>
        </div>
        <label className="field">
          Or paste rows from a spreadsheet
          <textarea className="input mono" rows={7} value={csv} onChange={(e) => (setCsv(e.target.value), setRows(null))} placeholder={TEMPLATE} />
        </label>
        <p className="tiny muted">
          Columns: <span className="kbd">date</span> (2026-11-05 or 05/11/2026), <span className="kbd">time</span> (14:30 or 2:30 pm, in the client's time zone), <span className="kbd">text</span>,{' '}
          <span className="kbd">channels</span> (network names like bluesky, channel names, or "all"), <span className="kbd">image_url</span> (links separated by spaces) and <span className="kbd">first_comment</span>. Rows without a
          date go into the next free posting time{client && !client.queueSlots?.length ? ' (this client has none set, so they become drafts)' : ''}.
        </p>
        <ErrorBanner error={error} />
        <div className="row">
          <button className="btn" disabled={!clientId || !csv.trim() || !!busy} onClick={() => run('check', async () => setRows((await api<{ rows: Row[] }>('/import/preview', { body: { clientId, csv } })).rows))}>
            {busy === 'check' && <Spinner />} Check rows
          </button>
          {rows && (
            <button
              className="btn primary"
              disabled={!good || !!busy}
              onClick={() =>
                run('import', async () => {
                  const r = await api<{ created: number; results: { row: number; ok: boolean; error?: string }[] }>('/import/run', { body: { clientId, csv } });
                  setDone(r);
                  setRows(null);
                  toast(`${r.created} post${r.created === 1 ? '' : 's'} imported`);
                })
              }
            >
              {busy === 'import' && <Spinner />} Import {good} post{good === 1 ? '' : 's'}
              {rows.length > good ? ` (skip ${rows.length - good})` : ''}
            </button>
          )}
        </div>
      </div>

      {done && (
        <div className={`banner ${done.results.some((r) => !r.ok) ? 'warning' : 'success'}`} style={{ marginTop: 16 }}>
          <div className="body">
            <strong>
              {done.created} post{done.created === 1 ? '' : 's'} imported.
            </strong>{' '}
            <Link to="/posts">See them in Posts</Link>.
            {done.results
              .filter((r) => !r.ok)
              .map((r) => (
                <div key={r.row} className="small">
                  Row {r.row}: {r.error}
                </div>
              ))}
          </div>
        </div>
      )}

      {rows && (
        <div className="card" style={{ marginTop: 16, overflowX: 'auto' }}>
          {rows.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>When</th>
                  <th>Channels</th>
                  <th>Post</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row}>
                    <td className="muted">{r.row}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{r.when === 'scheduled' ? fmt(r.scheduledAt, client?.timezone, { dateStyle: 'medium', timeStyle: 'short' }) : r.when === 'queue' ? 'Next free time' : 'Draft'}</td>
                    <td className="small">{r.channelNames.join(', ')}</td>
                    <td style={{ maxWidth: 420 }}>
                      <div className="clamp">{r.text}</div>
                      {!!r.images.length && <div className="tiny muted">{r.images.length} image{r.images.length === 1 ? '' : 's'}</div>}
                      {r.issues.map((i) => (
                        <div key={i} className="tiny" style={{ color: 'var(--error)' }}>
                          {i}
                        </div>
                      ))}
                    </td>
                    <td>{r.issues.length ? <AlertCircle size={16} color="var(--error)" /> : <CheckCircle2 size={16} color="var(--success)" />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty title="No rows found" />
          )}
        </div>
      )}
    </>
  );
}
