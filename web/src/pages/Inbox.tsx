import { Check, CornerDownRight, ExternalLink, Inbox as InboxIcon, RefreshCw, RotateCcw, Send, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { useApp } from '../components/Layout';
import { Avatar, Empty, ErrorBanner, Loading, Spinner, useLoad, useToast } from '../components/ui';
import { api } from '../lib/api';
import { platformInfo } from '../lib/platforms';
import { ago } from '../lib/time';

type Item = {
  id: string;
  clientId: string;
  clientName: string;
  channelName: string;
  platform: string;
  postId: string;
  postText: string;
  postUrl: string | null;
  author: { name: string; handle: string; avatarUrl: string | null };
  text: string;
  url: string | null;
  receivedAt: string;
  status: 'open' | 'done';
  isReplyToComment: boolean;
  isDirect?: boolean;
  isReview?: boolean;
  rating?: number | null;
  reply: { text: string; at: string; by: string | null } | null;
  replyError: string | null;
};

export function InboxPage() {
  const { clients, refreshAlerts } = useApp();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const client = params.get('client') ?? '';
  const status = params.get('status') ?? 'open';
  const q = `client=${client}&status=${status}`;
  const { data, error, reload } = useLoad(() => api<{ items: Item[]; open: number }>(`/inbox?${q}`), [q]);
  const [refreshing, setRefreshing] = useState(false);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const done = async (ids: string[], to: 'open' | 'done') => {
    await api('/inbox/status', { body: { ids, status: to } });
    reload();
    refreshAlerts();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inbox</h1>
          <p>Comments and replies on your brands' posts, from every network, in one place.</p>
        </div>
        <button
          className="btn"
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            try {
              const r = await api<{ found: number }>('/inbox/refresh', { method: 'POST' });
              toast(r.found ? `${r.found} new comment${r.found === 1 ? '' : 's'}` : 'Nothing new');
              reload();
              refreshAlerts();
            } finally {
              setRefreshing(false);
            }
          }}
        >
          {refreshing ? <Spinner /> : <RefreshCw size={15} />} Check now
        </button>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        <select className="input" style={{ width: 'auto' }} value={client} onChange={(e) => set('client', e.target.value)} aria-label="Brand">
          <option value="">All brands</option>
          {clients
            .filter((c) => !c.archivedAt)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
        <div className="seg" role="group" aria-label="Show">
          <button className={status === 'open' ? 'on' : ''} onClick={() => set('status', 'open')}>
            To answer{data && status === 'open' ? ` (${data.items.length})` : ''}
          </button>
          <button className={status === 'done' ? 'on' : ''} onClick={() => set('status', 'done')}>
            Done
          </button>
        </div>
        {status === 'open' && !!data?.items.length && (
          <button className="btn ghost sm" onClick={() => done(data.items.map((i) => i.id), 'done')}>
            <Check size={14} /> Mark all done
          </button>
        )}
      </div>
      <ErrorBanner error={error} />
      {!data ? (
        !error && <Loading />
      ) : !data.items.length ? (
        <Empty title={status === 'open' ? 'All caught up' : 'Nothing answered yet'} icon={<InboxIcon size={28} />}>
          New comments on Bluesky, Mastodon, Threads, Facebook and Instagram show up here within about 10 minutes. X and LinkedIn need higher API access for this.
        </Empty>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          {data.items.map((i) => (
            <InboxCard key={i.id} item={i} onChange={() => (reload(), refreshAlerts())} onStatus={(to) => done([i.id], to)} />
          ))}
        </div>
      )}
    </>
  );
}

function InboxCard({ item: i, onChange, onStatus }: { item: Item; onChange: () => void; onStatus: (to: 'open' | 'done') => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [ideas, setIdeas] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(i.replyError);
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
  return (
    <article className="card pad stack" style={{ gap: 10 }}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 10, flexWrap: 'nowrap', minWidth: 0 }}>
          <Avatar src={i.author.avatarUrl} name={i.author.name} platform={i.platform} size={36} />
          <div style={{ minWidth: 0 }}>
            <strong className="small">{i.author.name}</strong> <span className="tiny muted">{i.author.handle}</span>
            <div className="tiny muted">
              {i.clientName} · {platformInfo(i.platform).label} · {i.channelName} · {ago(i.receivedAt)}
            </div>
          </div>
        </div>
        <div className="row" style={{ gap: 4 }}>
          {i.url && (
            <a href={i.url} target="_blank" rel="noreferrer" className="btn ghost sm" aria-label="Open on the network">
              <ExternalLink size={14} />
            </a>
          )}
          {i.status === 'open' ? (
            <button className="btn ghost sm" onClick={() => onStatus('done')}>
              <Check size={14} /> Done
            </button>
          ) : (
            <button className="btn ghost sm" onClick={() => onStatus('open')}>
              <RotateCcw size={14} /> Reopen
            </button>
          )}
        </div>
      </div>
      {i.isReview && i.rating && (
        <span className="stars" aria-label={`${i.rating} out of 5 stars`}>
          {'★'.repeat(i.rating)}
          <span className="muted">{'★'.repeat(5 - i.rating)}</span>
        </span>
      )}
      {(i.text || !i.isReview) && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{i.text}</p>}
      {i.isReview ? (
        <span className="tiny muted">Google review of {i.channelName}. Your reply is public.</span>
      ) : i.isDirect ? (
        <span className="tiny muted">WhatsApp message from {i.author.handle}. Free replies work for 24 hours after their last message.</span>
      ) : (
        <Link to={`/posts/${i.postId}`} className="tiny muted row" style={{ gap: 4, flexWrap: 'nowrap' }}>
          <CornerDownRight size={12} />
          <span className="clamp">
            {i.isReplyToComment ? 'In a conversation on: ' : 'On: '}
            {i.postText}
          </span>
        </Link>
      )}
      {i.reply ? (
        <div className="extra small">
          <strong>Replied{i.reply.by ? ` by ${i.reply.by}` : ''}</strong> <span className="tiny muted">{ago(i.reply.at)}</span>
          <div style={{ whiteSpace: 'pre-wrap' }}>{i.reply.text}</div>
        </div>
      ) : (
        i.platform !== 'telegram' && (
          <form
            className="stack"
            style={{ gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              run('send', async () => {
                await api(`/inbox/${i.id}/reply`, { body: { text } });
                toast('Reply posted');
                onChange();
              });
            }}
          >
            {ideas && (
              <div className="stack" style={{ gap: 6 }}>
                {ideas.map((r) => (
                  <button key={r} type="button" className="suggestion small" style={{ textAlign: 'left' }} onClick={() => setText(r)}>
                    {r}
                  </button>
                ))}
              </div>
            )}
            <textarea className="input" rows={2} placeholder={`Reply as ${i.clientName}…`} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reply" />
            <div className="row">
              <button className="btn primary sm" disabled={!text.trim() || !!busy}>
                {busy === 'send' ? <Spinner size={14} /> : <Send size={14} />} Reply
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={!!busy}
                onClick={() => run('ai', async () => setIdeas((await api<{ replies: string[] }>(`/inbox/${i.id}/suggest`, { method: 'POST' })).replies))}
              >
                {busy === 'ai' ? <Spinner size={14} /> : <Sparkles size={14} />} Suggest replies
              </button>
            </div>
          </form>
        )
      )}
      <ErrorBanner error={error} />
    </article>
  );
}
