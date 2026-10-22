import { CheckCircle2, ExternalLink, Printer, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';

import { ErrorBanner, Loading, PlatformBadge, useLoad } from '../components/ui';
import { api } from '../lib/api';
import { fmt, utcToZoned } from '../lib/time';

type Report = {
  agency: string;
  client: { id: string; name: string; timezone: string; color: string };
  month: string;
  summary: { total: number; published: number; failed: number; onTime: number; successRate: number | null; retried: number; engagement?: number; clicks?: number };
  items: { id: string; status: string; platform: string; channelName: string; channelHandle: string; scheduledAt: string; publishedAt: string | null; delayMinutes: number | null; url: string | null; attempts: number; text: string; error: string | null; likes?: number | null; comments?: number | null; shares?: number | null; clicks?: number }[];
  generatedAt: string;
};

const responseText = (i: { likes?: number | null; comments?: number | null; shares?: number | null; clicks?: number }) =>
  [i.likes != null && `${i.likes} likes`, i.comments != null && `${i.comments} comments`, i.shares ? `${i.shares} shares` : null, i.clicks ? `${i.clicks} clicks` : null].filter(Boolean).join(' · ');

const thisMonth = () => utcToZoned(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone).date.slice(0, 7);

/** Signed-in view, inside the app. */
export function ReportPage() {
  const { id } = useParams();
  const [month, setMonth] = useState(thisMonth());
  const { data, error } = useLoad(() => api<Report>(`/reports/proof?client=${id}&month=${month}`), [id, month]);
  return (
    <>
      <div className="row between no-print" style={{ marginBottom: 16 }}>
        <Link to={`/clients/${id}`} className="small">
          ← Back to client
        </Link>
        <div className="row">
          <input type="month" className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
          <button className="btn" onClick={() => window.print()}>
            <Printer size={15} /> Print or save as PDF
          </button>
        </div>
      </div>
      <ErrorBanner error={error} />
      {data ? <ReportBody r={data} /> : !error && <Loading />}
    </>
  );
}

/** Public view for the client, from the share link. */
export function PublicReport() {
  const { token } = useParams();
  const [month, setMonth] = useState(thisMonth());
  const { data, error } = useLoad(() => api<Report>(`/public/report/${token}?month=${month}`), [token, month]);
  return (
    <div className="report">
      <div className="row between no-print" style={{ marginBottom: 16 }}>
        <input type="month" className="input" style={{ width: 'auto' }} value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
        <button className="btn" onClick={() => window.print()}>
          <Printer size={15} /> Print or save as PDF
        </button>
      </div>
      <ErrorBanner error={error} />
      {data ? <ReportBody r={data} /> : !error && <Loading />}
    </div>
  );
}

function ReportBody({ r }: { r: Report }) {
  const tz = r.client.timezone;
  const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${r.month}-01T00:00:00Z`));
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row between" style={{ alignItems: 'flex-end' }}>
        <div>
          <div className="small muted">{r.agency} · Proof of publishing</div>
          <h1>
            {r.client.name} · {monthName}
          </h1>
        </div>
        <div className="brand" style={{ color: 'var(--text)', padding: 0, fontSize: 16 }}>
          <img src="/mark.svg" alt="" style={{ width: 22, height: 22 }} /> Surecast
        </div>
      </div>
      <div className="grid stats">
        <div className="card stat good">
          <div className="label">Posts delivered</div>
          <div className="value">{r.summary.published}</div>
        </div>
        <div className="card stat">
          <div className="label">Delivery rate</div>
          <div className="value">{r.summary.successRate == null ? '–' : `${r.summary.successRate}%`}</div>
        </div>
        <div className="card stat">
          <div className="label">On time (within 5 min)</div>
          <div className="value">{r.summary.onTime}</div>
        </div>
        <div className={`card stat ${r.summary.failed ? 'bad' : ''}`}>
          <div className="label">Did not go out</div>
          <div className="value">{r.summary.failed}</div>
        </div>
        {!!(r.summary.engagement || r.summary.clicks) && (
          <>
            <div className="card stat">
              <div className="label">Likes, comments and shares</div>
              <div className="value">{(r.summary.engagement ?? 0).toLocaleString()}</div>
            </div>
            <div className="card stat">
              <div className="label">Link clicks</div>
              <div className="value">{(r.summary.clicks ?? 0).toLocaleString()}</div>
            </div>
          </>
        )}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <div className="report" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Scheduled</th>
                <th>Went out</th>
                <th>Post</th>
                <th>Response</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {r.items.map((i) => (
                <tr key={i.id}>
                  <td>
                    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      <PlatformBadge platform={i.platform} size={18} /> {i.channelName}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmt(i.scheduledAt, tz, { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {i.status === 'published' ? (
                      <span className="row" style={{ gap: 4, color: 'var(--success)', flexWrap: 'nowrap' }}>
                        <CheckCircle2 size={14} /> {fmt(i.publishedAt, tz, { timeStyle: 'short' })}
                        {!!i.delayMinutes && i.delayMinutes > 5 && <span className="muted tiny">(+{i.delayMinutes} min)</span>}
                      </span>
                    ) : (
                      <span className="row" style={{ gap: 4, color: 'var(--error)', flexWrap: 'nowrap' }} title={i.error ?? ''}>
                        <XCircle size={14} /> Not posted
                      </span>
                    )}
                  </td>
                  <td style={{ maxWidth: 380 }}>
                    <div className="clamp">{i.text}</div>
                    {i.status !== 'published' && i.error && <div className="tiny" style={{ color: 'var(--error)' }}>{i.error}</div>}
                  </td>
                  <td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>
                    {i.likes != null || i.clicks ? responseText(i) : ''}
                  </td>
                  <td>
                    {i.url && (
                      <a href={i.url} target="_blank" rel="noreferrer" aria-label="Open live post">
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </td>
                </tr>
              ))}
              {!r.items.length && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 30 }}>
                    Nothing was scheduled this month.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="tiny muted">
        Times in {tz.replace(/_/g, ' ')}. Generated {fmt(r.generatedAt, tz)} by Surecast. Every post goes out, or you know why.
      </p>
    </div>
  );
}
