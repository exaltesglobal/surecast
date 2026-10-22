import { Copy, ExternalLink, ListPlus, MessageSquare, Pencil, Repeat, RotateCcw, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import { useApp } from '../components/Layout';
import { Avatar, ErrorBanner, Loading, MediaThumb, Pill, Spinner, useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';
import { platformInfo } from '../lib/platforms';
import { ago, fmt } from '../lib/time';
import type { Post } from '../lib/types';

const OUTCOME: Record<string, string> = {
  success: 'Posted',
  temporary_error: 'Temporary error, will retry',
  auth_error: 'Connection problem',
  permanent_error: 'Rejected',
  interrupted: 'Interrupted',
  running: 'In progress',
};

export function PostDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { clients, refreshAlerts } = useApp();
  const { data, error, reload } = useLoad(() => api<{ post: Post }>(`/posts/${id}`), [id]);
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState('');

  if (!data) return error ? <ErrorBanner error={error} /> : <Loading />;
  const p = data.post;
  const client = clients.find((c) => c.id === p.clientId);
  const tz = client?.timezone;
  const editable = !['published', 'cancelled'].includes(p.status);
  const canCancel = p.targets.some((t) => ['draft', 'awaiting_approval', 'scheduled', 'retrying'].includes(t.status));
  const canDelete = !p.targets.some((t) => t.status === 'published' || t.status === 'publishing');

  const act = async (name: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(name);
    try {
      await fn();
      toast(done);
      refreshAlerts();
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row" style={{ gap: 8 }}>
            <h1>Post</h1>
            <Pill status={p.status} />
          </div>
          <p>
            {client && (
              <>
                <span className="client-dot" style={{ background: client.color }} /> {client.name} ·{' '}
              </>
            )}
            {p.scheduledAt ? `${new Date(p.scheduledAt).getTime() < Date.now() ? 'Scheduled for' : 'Goes out'} ${fmt(p.scheduledAt, tz)}` : 'No time set'}
            {p.source === 'api' && ' · created through the API'}
            {p.source === 'csv' && ' · imported from a spreadsheet'}
            {p.source === 'rss' && ' · from a feed'}
          </p>
        </div>
        <div className="row">
          {editable && (
            <Link to={`/posts/${p.id}/edit`} className="btn">
              <Pencil size={15} /> Edit
            </Link>
          )}
          <button className="btn" disabled={!!busy} onClick={() => act('dup', async () => nav(`/posts/${(await api<{ id: string }>(`/posts/${p.id}/duplicate`, { method: 'POST' })).id}/edit`), 'Copied as a new draft')}>
            <Copy size={15} /> Duplicate
          </button>
          {canCancel && (
            <button className="btn danger" disabled={!!busy} onClick={() => confirm('Cancel this post on every channel that has not posted yet?') && act('cancel', () => api(`/posts/${p.id}/cancel`, { method: 'POST' }), 'Cancelled')}>
              <XCircle size={15} /> Cancel
            </button>
          )}
          {canDelete && (
            <button
              className="btn danger"
              disabled={!!busy}
              onClick={async () => {
                if (!confirm('Delete this post for good?')) return;
                await api(`/posts/${p.id}`, { method: 'DELETE' });
                toast('Deleted');
                nav('/posts');
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="grid two" style={{ alignItems: 'start' }}>
        <div className="stack">
          {p.targets.map((t) => (
            <section key={t.id} className="card">
              <div className="card-head">
                <div className="row">
                  <Avatar src={t.channelAvatar} name={t.channelName ?? '?'} platform={t.platform} />
                  <div>
                    <strong>{t.channelName ?? 'Removed channel'}</strong>
                    <div className="tiny muted">
                      {platformInfo(t.platform).label} {t.channelHandle}
                    </div>
                  </div>
                </div>
                <Pill status={t.status} />
              </div>
              <div className="card-body stack">
                {t.status === 'published' && (
                  <div className="row between">
                    <span className="small">
                      Posted {fmt(t.publishedAt, tz)}
                      {t.attempts > 1 && <span className="muted"> after {t.attempts} attempts</span>}
                    </span>
                    {t.remoteUrl && (
                      <a href={t.remoteUrl} target="_blank" rel="noreferrer" className="btn sm">
                        View live <ExternalLink size={13} />
                      </a>
                    )}
                  </div>
                )}
                {t.metrics && (
                  <div className="row small" style={{ gap: 14 }}>
                    {t.metrics.likes != null && <span><strong>{t.metrics.likes}</strong> likes</span>}
                    {t.metrics.comments != null && <span><strong>{t.metrics.comments}</strong> comments</span>}
                    {t.metrics.shares != null && <span><strong>{t.metrics.shares}</strong> shares</span>}
                    {t.metrics.views != null && <span><strong>{t.metrics.views}</strong> views</span>}
                    <span><strong>{t.metrics.clicks}</strong> link clicks</span>
                    {t.metrics.at && <span className="tiny muted">updated {ago(t.metrics.at)}</span>}
                  </div>
                )}
                {t.followUps && (t.followUps.done < t.followUps.total || t.followUps.error) && (
                  <div className={`banner ${t.followUps.pending ? 'info' : 'warning'}`}>
                    <div className="body">
                      <strong>
                        {t.followUps.done} of {t.followUps.total} follow-ups posted
                      </strong>
                      {t.followUps.error && <p>{t.followUps.error}</p>}
                      {t.followUps.pending ? (
                        <p className="tiny">Surecast will try again shortly.</p>
                      ) : (
                        <button className="btn sm" disabled={!!busy} onClick={() => act(`f${t.id}`, () => api(`/posts/${p.id}/retry-followups`, { method: 'POST' }), 'Trying the rest again')}>
                          <RotateCcw size={14} /> Try the rest again
                        </button>
                      )}
                    </div>
                  </div>
                )}
                {t.followUps && t.followUps.done === t.followUps.total && !t.followUps.error && (
                  <span className="tiny muted">Thread and first comment posted ({t.followUps.total}).</span>
                )}
                {t.error && t.status !== 'published' && (
                  <div className={`banner ${t.status === 'retrying' ? 'warning' : 'error'}`}>
                    <div className="body">
                      <strong>{t.error.message}</strong>
                      <p>{t.error.hint}</p>
                      {t.status === 'retrying' && t.nextAttemptAt && <p className="tiny">Next try {fmt(t.nextAttemptAt, tz)}.</p>}
                    </div>
                  </div>
                )}
                {t.preflightOk === false && t.status === 'scheduled' && (
                  <div className="banner warning">
                    <div className="body">
                      <strong>Pre-flight check found a problem</strong>
                      <p>{t.preflightMessage}</p>
                    </div>
                  </div>
                )}
                {t.preflightOk === true && t.status === 'scheduled' && <span className="pill success">Pre-flight check passed</span>}
                {t.status === 'failed' && (
                  <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => act(t.id, () => api(`/posts/${p.id}/retry`, { body: { targetId: t.id } }), 'Retrying now')}>
                    {busy === t.id ? <Spinner /> : <RotateCcw size={14} />} Retry now
                  </button>
                )}
                {t.body != null && (
                  <details>
                    <summary className="small muted">Custom text for this channel</summary>
                    <p style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>{t.body}</p>
                  </details>
                )}
                {!!t.log?.length && (
                  <details open={t.status !== 'published'}>
                    <summary className="small muted">Attempt log ({t.log.length})</summary>
                    <ul className="timeline" style={{ marginTop: 10 }}>
                      {t.log.map((a) => (
                        <li key={a.number + a.startedAt} className={a.outcome}>
                          <strong>
                            #{a.number} {OUTCOME[a.outcome] ?? a.outcome}
                          </strong>{' '}
                          <span className="muted">{fmt(a.startedAt, tz, { dateStyle: 'short', timeStyle: 'medium' })}</span>
                          {a.message && <div className="muted">{a.message}</div>}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </section>
          ))}
        </div>

        <div className="stack">
          <section className="card pad stack">
            <h3>Content</h3>
            <p style={{ whiteSpace: 'pre-wrap' }}>{p.body || <em className="muted">No text</em>}</p>
            {!!p.thread.length && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="tiny muted row" style={{ gap: 4 }}>
                  <ListPlus size={13} /> Thread
                </span>
                {p.thread.map((part, i) => (
                  <p key={i} className="extra" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                    <strong className="tiny">{i + 2}.</strong> {part}
                  </p>
                ))}
              </div>
            )}
            {p.firstComment && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="tiny muted row" style={{ gap: 4 }}>
                  <MessageSquare size={13} /> First comment
                </span>
                <p className="extra" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                  {p.firstComment}
                </p>
              </div>
            )}
            {(p.recycle.days > 0 && p.recycle.times > 0) || p.recycledFrom ? (
              <span className="small muted row" style={{ gap: 6 }}>
                <Repeat size={14} />
                {p.recycle.days > 0 && p.recycle.times > 0 ? `Repeats every ${p.recycle.days} days, ${p.recycle.times} more time${p.recycle.times === 1 ? '' : 's'}.` : ''}
                {p.recycledFrom && (
                  <Link to={`/posts/${p.recycledFrom}`} className="small">
                    A repeat of an earlier post
                  </Link>
                )}
              </span>
            ) : null}
            {!!p.media.length && (
              <div className="thumbs">
                {p.media.map((m) => (
                  <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="thumb">
                    <MediaThumb m={m} />
                  </a>
                ))}
              </div>
            )}
          </section>
          <section className="card">
            <div className="card-head">
              <h3>Activity and comments</h3>
              {p.approvalStatus !== 'not_needed' && <Pill status={p.approvalStatus === 'approved' ? 'success' : p.approvalStatus === 'pending' ? 'awaiting_approval' : p.approvalStatus}>{p.approvalStatus.replace('_', ' ')}</Pill>}
            </div>
            <div className="card-body stack">
              {p.comments?.length ? (
                p.comments.map((c) => (
                  <div key={c.id} className="small">
                    <strong>{c.author}</strong>
                    {c.fromClient && <span className="pill neutral" style={{ marginLeft: 6 }}>Reviewer</span>} <span className="muted tiny">{fmt(c.createdAt, tz, { dateStyle: 'short', timeStyle: 'short' })}</span>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                  </div>
                ))
              ) : (
                <p className="muted small">No comments yet.</p>
              )}
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  act('comment', () => api(`/posts/${p.id}/comments`, { body: { body: comment } }), 'Comment added').then(() => setComment(''));
                }}
              >
                <input className="input" style={{ flex: 1 }} placeholder="Add an internal note" value={comment} onChange={(e) => setComment(e.target.value)} />
                <button className="btn sm" disabled={!comment.trim() || !!busy}>
                  Add
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
