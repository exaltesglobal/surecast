import { CheckCircle2, ExternalLink, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';

import { Empty, ErrorBanner, Loading, Pill, PlatformBadge, Spinner, useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmt } from '../lib/time';
import type { Post } from '../lib/types';

type PortalData = { agency: string; client: { name: string; color: string; timezone: string }; pending: Post[]; upcoming: Post[]; recent: Post[] };

/** What the client sees from their link: posts to approve, what's coming, what went out. */
export function Portal() {
  const { token } = useParams();
  const { data, error, reload } = useLoad(() => api<PortalData>(`/public/portal/${token}`), [token]);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('sc_portal_name') ?? '';
    } catch {
      return '';
    }
  });
  if (!data) return <div className="report">{error ? <ErrorBanner error={error} /> : <Loading />}</div>;
  const tz = data.client.timezone;
  return (
    <div className="report stack" style={{ gap: 24, maxWidth: 760 }}>
      <div>
        <div className="small muted">{data.agency}</div>
        <h1>Posts for {data.client.name}</h1>
        <p className="muted">Times shown in {tz.replace(/_/g, ' ')}.</p>
      </div>
      <label className="field" style={{ maxWidth: 320 }}>
        Your name <span className="hint">So the team knows who approved.</span>
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            try {
              localStorage.setItem('sc_portal_name', e.target.value);
            } catch {
              /* ignore */
            }
          }}
        />
      </label>

      <section className="stack">
        <div className="row between">
          <h2>Waiting for you ({data.pending.length})</h2>
          {data.pending.length > 1 && <ApproveAll posts={data.pending} token={token!} name={name} onDone={reload} />}
        </div>
        {data.pending.length ? data.pending.map((p) => <ApprovalCard key={p.id} post={p} tz={tz} token={token!} name={name} onDone={reload} />) : <div className="card"><Empty title="You're all caught up" icon={<CheckCircle2 size={28} />}>New posts to review will appear here.</Empty></div>}
      </section>

      {!!data.upcoming.length && (
        <section className="stack">
          <h2>Coming up</h2>
          <div className="card list">
            {data.upcoming.map((p) => (
              <div key={p.id} className="list-item">
                <div className="grow">
                  <div className="small muted">{fmt(p.scheduledAt, tz)}</div>
                  <div className="clamp">{p.body}</div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  {p.targets.map((t) => (
                    <PlatformBadge key={t.id} platform={t.platform} size={18} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!!data.recent.length && (
        <section className="stack">
          <h2>Recently posted</h2>
          <div className="card list">
            {data.recent.map((p) => (
              <div key={p.id} className="list-item">
                <div className="grow">
                  <div className="small muted">{fmt(p.scheduledAt, tz)}</div>
                  <div className="clamp">{p.body}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {p.targets
                    .filter((t) => t.remoteUrl)
                    .map((t) => (
                      <a key={t.id} href={t.remoteUrl!} target="_blank" rel="noreferrer" className="row" style={{ gap: 3 }}>
                        <PlatformBadge platform={t.platform} size={18} />
                        <ExternalLink size={12} />
                      </a>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="tiny muted">Powered by Surecast</p>
    </div>
  );
}

function ApprovalCard({ post, tz, token, name, onDone }: { post: Post; tz: string; token: string; name: string; onDone: () => void }) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = async (decision: 'approve' | 'request-changes') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/public/portal/${token}/posts/${post.id}/${decision}`, { body: { name, comment } });
      toast(decision === 'approve' ? 'Approved. Thank you!' : 'Sent to the team');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card pad stack">
      <div className="row between">
        <span className="small">{post.scheduledAt ? `Planned for ${fmt(post.scheduledAt, tz)}` : 'No date yet'}</span>
        <div className="row" style={{ gap: 4 }}>
          {post.approvalStatus === 'changes_requested' && <Pill status="changes_requested" />}
          {post.targets.map((t) => (
            <PlatformBadge key={t.id} platform={t.platform} size={20} />
          ))}
        </div>
      </div>
      <p style={{ whiteSpace: 'pre-wrap' }}>{post.body}</p>
      {!!post.media.length && (
        <div className="thumbs">
          {post.media.map((m) => (
            <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="thumb">
              <img src={m.url} alt={m.alt} />
            </a>
          ))}
        </div>
      )}
      {post.targets
        .filter((t) => t.body)
        .map((t) => (
          <details key={t.id}>
            <summary className="small muted">Different text on {t.channelName}</summary>
            <p style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{t.body}</p>
          </details>
        ))}
      {!!post.comments?.length && (
        <div className="stack" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          {post.comments
            .filter((c) => c.kind !== 'comment')
            .map((c) => (
              <div key={c.id} className="small">
                <strong>{c.author}</strong> <span className="muted tiny">{fmt(c.createdAt, tz, { dateStyle: 'short', timeStyle: 'short' })}</span>
                <div>{c.body}</div>
              </div>
            ))}
        </div>
      )}
      {asking && <textarea className="input" rows={3} placeholder="What would you like changed?" value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />}
      <ErrorBanner error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => decide('approve')}>
          {busy ? <Spinner /> : <CheckCircle2 size={16} />} Approve
        </button>
        {asking ? (
          <button className="btn" disabled={busy || !comment.trim()} onClick={() => decide('request-changes')}>
            Send request
          </button>
        ) : (
          <button className="btn" onClick={() => setAsking(true)}>
            <MessageSquare size={16} /> Request changes
          </button>
        )}
      </div>
    </div>
  );
}

function ApproveAll({ posts, token, name, onDone }: { posts: Post[]; token: string; name: string; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn"
      disabled={busy}
      onClick={async () => {
        if (!confirm(`Approve all ${posts.length} posts?`)) return;
        setBusy(true);
        for (const p of posts) await api(`/public/portal/${token}/posts/${p.id}/approve`, { body: { name } }).catch(() => undefined);
        setBusy(false);
        toast('All approved. Thank you!');
        onDone();
      }}
    >
      {busy ? <Spinner /> : <CheckCircle2 size={16} />} Approve all
    </button>
  );
}
