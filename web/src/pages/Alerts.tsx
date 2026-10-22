import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useApp } from '../components/Layout';
import { Empty, Loading, useLoad } from '../components/ui';
import { api } from '../lib/api';
import { ago, fmt } from '../lib/time';
import type { Alert } from '../lib/types';

export function AlertsPage() {
  const { refreshAlerts, clients } = useApp();
  const [all, setAll] = useState(false);
  const { data, reload } = useLoad(() => api<{ alerts: Alert[] }>(`/alerts${all ? '?all=1' : ''}`), [all]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p>Anything that failed or might fail. These are also emailed to your team.</p>
        </div>
        <label className="check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show resolved
        </label>
      </div>
      {!data ? (
        <Loading />
      ) : data.alerts.length ? (
        <div className="card list">
          {data.alerts.map((a) => {
            const client = clients.find((c) => c.id === a.clientId);
            return (
              <div key={a.id} className="list-item" style={{ opacity: a.resolvedAt ? 0.6 : 1 }}>
                {a.severity === 'error' ? <AlertTriangle size={18} color="var(--error)" /> : a.severity === 'warning' ? <AlertTriangle size={18} color="var(--warning)" /> : <Info size={18} />}
                <div className="grow">
                  <strong>{a.title}</strong>
                  {a.detail && <p className="small muted">{a.detail}</p>}
                  <div className="tiny muted row" style={{ gap: 8 }}>
                    {client && (
                      <span className="row" style={{ gap: 4 }}>
                        <span className="client-dot" style={{ background: client.color }} /> {client.name}
                      </span>
                    )}
                    <span title={fmt(a.createdAt)}>{ago(a.createdAt)}</span>
                    {a.resolvedAt && <span>Resolved {ago(a.resolvedAt)}</span>}
                    {a.postId && <Link to={`/posts/${a.postId}`}>Open post</Link>}
                    {!a.postId && a.clientId && <Link to={`/clients/${a.clientId}`}>Open client</Link>}
                  </div>
                </div>
                {!a.resolvedAt && (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      await api(`/alerts/${a.id}/resolve`, { method: 'POST' });
                      reload();
                      refreshAlerts();
                    }}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card">
          <Empty title="No open alerts" icon={<CheckCircle2 size={28} />}>
            Everything is going out as planned.
          </Empty>
        </div>
      )}
    </>
  );
}
