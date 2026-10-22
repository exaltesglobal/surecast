import { FileUp } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';

import { useApp } from '../components/Layout';
import { Empty, ErrorBanner, Loading, MediaThumb, Pill, PlatformBadge, useLoad } from '../components/ui';
import { api } from '../lib/api';
import { fmt } from '../lib/time';
import type { Post } from '../lib/types';

const TABS = [
  { key: 'upcoming', label: 'Upcoming', status: 'scheduled,publishing', order: 'asc' },
  { key: 'attention', label: 'Needs action', status: 'failed,partial,changes_requested', order: 'desc' },
  { key: 'approval', label: 'Awaiting approval', status: 'awaiting_approval', order: 'asc' },
  { key: 'drafts', label: 'Drafts', status: 'draft', order: 'desc' },
  { key: 'posted', label: 'Posted', status: 'published', order: 'desc' },
] as const;

export function PostsPage() {
  const { clients } = useApp();
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('upcoming');
  const [clientId, setClientId] = useState('');
  const t = TABS.find((x) => x.key === tab)!;
  const { data, error, loading } = useLoad(() => api<{ posts: Post[] }>(`/posts?status=${t.status}&order=${t.order}&limit=200${clientId ? `&client=${clientId}` : ''}`), [tab, clientId]);
  const client = (id: string) => clients.find((c) => c.id === id);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Posts</h1>
          <p>Every post and where it stands on each channel.</p>
        </div>
        <div className="row">
          <Link to="/posts/import" className="btn">
            <FileUp size={15} /> Import CSV
          </Link>
          <select className="input" style={{ width: 'auto' }} value={clientId} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
            <option value="">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Link to="/posts/new" className="btn primary">
            New post
          </Link>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.key} className={tab === x.key ? 'on' : ''} onClick={() => setTab(x.key)} role="tab" aria-selected={tab === x.key}>
            {x.label}
          </button>
        ))}
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? (
        <Loading />
      ) : data?.posts.length ? (
        <div className="card list">
          {data.posts.map((p) => {
            const c = client(p.clientId);
            return (
              <Link key={p.id} to={`/posts/${p.id}`} className="list-item" style={{ color: 'inherit', textDecoration: 'none' }}>
                {p.media[0] ? (
                  <MediaThumb m={p.media[0]} style={{ width: 52, height: 52, borderRadius: 8, objectFit: 'cover', flex: 'none' }} />
                ) : (
                  <span style={{ width: 52, height: 52, borderRadius: 8, background: 'var(--surface-2)', flex: 'none' }} />
                )}
                <div className="grow">
                  <div className="row" style={{ gap: 8, marginBottom: 2 }}>
                    {c && (
                      <span className="small row" style={{ gap: 5 }}>
                        <span className="client-dot" style={{ background: c.color }} />
                        {c.name}
                      </span>
                    )}
                    <span className="small muted">{p.scheduledAt ? fmt(p.scheduledAt, c?.timezone) : 'No time set'}</span>
                    {p.source === 'api' && <span className="pill neutral">API</span>}
                  </div>
                  <div className="clamp">{p.body || <em className="muted">Image only</em>}</div>
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    {p.targets.map((t) => (
                      <span key={t.id} className="row" style={{ gap: 4 }} title={`${t.channelName}: ${t.status}${t.error ? ` (${t.error.message})` : ''}`}>
                        <PlatformBadge platform={t.platform} size={18} />
                        {t.status !== p.status && <Pill status={t.status} />}
                      </span>
                    ))}
                  </div>
                </div>
                <Pill status={p.status} />
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="card">
          <Empty title={tab === 'attention' ? 'Nothing needs action' : 'No posts here yet'}>{tab === 'attention' ? 'Failed posts and client change requests will show up here.' : <Link to="/posts/new">Write a post</Link>}</Empty>
        </div>
      )}
    </>
  );
}
