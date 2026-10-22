import { AlertCircle, CalendarPlus, ImagePlus, Send, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';

import { AltTextButton, Assistant, type AiStatus } from '../components/Assistant';
import { Extras, SnippetPicker } from '../components/ComposerExtras';
import { useApp } from '../components/Layout';
import { Avatar, Empty, ErrorBanner, Loading, MediaThumb, PlatformBadge, Spinner, useLoad, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { platformInfo } from '../lib/platforms';
import { utcToZoned, zonedToUtc } from '../lib/time';
import type { Channel, Media, Post, Snippet } from '../lib/types';

type Check = { channelId: string; platform: string; count: number; max: number; issues: string[]; warnings?: string[] };

export function Composer() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const { clients } = useApp();
  const active = clients.filter((c) => !c.archivedAt);

  const [loaded, setLoaded] = useState(!id);
  const [clientId, setClientId] = useState(params.get('client') ?? (active.length === 1 ? active[0].id : ''));
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [body, setBody] = useState(params.get('text') ?? '');
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<string>('all');
  const [media, setMedia] = useState<Media[]>([]);
  const [date, setDate] = useState(params.get('date') ?? '');
  const [time, setTime] = useState('09:00');
  const [checks, setChecks] = useState<Check[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);
  const [post, setPost] = useState<Post | null>(null);
  const [thread, setThread] = useState<string[]>([]);
  const [firstComment, setFirstComment] = useState('');
  const [recycle, setRecycle] = useState({ days: 0, times: 0 });
  const snippets = useLoad(() => api<{ snippets: Snippet[] }>('/snippets'));
  const fileRef = useRef<HTMLInputElement>(null);
  const ai = useLoad(() => api<AiStatus>('/ai/status'));

  const client = clients.find((c) => c.id === clientId);
  const tz = client?.timezone ?? 'UTC';

  // Editing: load the post.
  useEffect(() => {
    if (!id) return;
    api<{ post: Post }>(`/posts/${id}`).then(({ post }) => {
      setPost(post);
      setClientId(post.clientId);
      setBody(post.body);
      setMedia(post.media);
      setThread(post.thread);
      setFirstComment(post.firstComment);
      setRecycle(post.recycle);
      const editable = post.targets.filter((t) => t.status !== 'cancelled');
      setSelected(editable.map((t) => t.channelId));
      setOverrides(Object.fromEntries(editable.filter((t) => t.body != null).map((t) => [t.channelId, t.body!])));
      const c = clients.find((x) => x.id === post.clientId);
      if (post.scheduledAt) {
        const z = utcToZoned(post.scheduledAt, c?.timezone ?? 'UTC');
        setDate(z.date);
        setTime(z.time);
      }
      setLoaded(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!clientId) return setChannels([]);
    api<{ channels: Channel[] }>(`/channels?client=${clientId}`).then((r) => {
      setChannels(r.channels);
      if (!id) setSelected(r.channels.filter((c) => c.status !== 'disconnected').map((c) => c.id));
    });
  }, [clientId, id]);

  // Live checks against each network's rules.
  useEffect(() => {
    if (!selected.length) return setChecks([]);
    const t = window.setTimeout(() => {
      api<{ channels: Check[] }>('/posts/validate', { body: { body, mediaIds: media.map((m) => m.id), channelIds: selected, overrides, thread, firstComment } })
        .then((r) => setChecks(r.channels))
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(t);
  }, [body, media, selected, overrides, thread, firstComment]);

  const selectedChannels = useMemo(() => channels.filter((c) => selected.includes(c.id)), [channels, selected]);
  const lockedChannelIds = new Set(post?.targets.filter((t) => t.status === 'published' || t.status === 'publishing').map((t) => t.channelId) ?? []);
  const textFor = (chId: string) => overrides[chId] ?? body;
  const hasIssues = checks.some((c) => c.issues.length);

  const upload = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const form = new FormData();
        form.append('file', f);
        const r = await api<{ media: Media }>('/media', { form });
        setMedia((m) => [...m, r.media]);
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const save = async (action: 'draft' | 'schedule' | 'now' | 'queue') => {
    setBusy(action);
    setError(null);
    try {
      const scheduledAt = date && time ? zonedToUtc(date, time, tz).toISOString() : null;
      const payload = {
        clientId,
        body,
        mediaIds: media.map((m) => m.id),
        channelIds: selected.filter((c) => !lockedChannelIds.has(c)),
        overrides,
        scheduledAt,
        action,
        thread: thread.filter((t) => t.trim()),
        firstComment,
        recycle: recycle.days > 0 && recycle.times > 0 ? recycle : { days: 0, times: 0 },
      };
      const r = id ? await api<{ post: Post }>(`/posts/${id}`, { method: 'PATCH', body: payload }) : await api<{ post: Post }>('/posts', { body: payload });
      toast(
        action === 'draft'
          ? 'Draft saved'
          : action === 'now'
            ? 'Posting now'
            : r.post.status === 'awaiting_approval'
              ? 'Sent for approval'
              : action === 'queue'
                ? `Added to the queue for ${new Date(r.post.scheduledAt!).toLocaleString(undefined, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
                : 'Scheduled',
      );
      nav(`/posts/${r.post.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.details) setChecks((prev) => prev.map((c) => ({ ...c, issues: e.details!.find((d) => d.channelId === c.channelId)?.issues ?? c.issues })));
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!loaded) return <Loading />;
  if (!active.length)
    return (
      <div className="card">
        <Empty title="Add a brand first">
          Posts belong to a brand. <Link to="/clients?new=1">Add your first brand</Link>.
        </Empty>
      </div>
    );

  const editingText = tab === 'all' ? body : textFor(tab);
  const tabCheck = tab === 'all' ? null : checks.find((c) => c.channelId === tab);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{id ? 'Edit post' : 'New post'}</h1>
          <p>Write once, adjust for each network if you like.</p>
        </div>
      </div>
      <div className="composer">
        <div className="stack">
          <div className="card pad stack">
            <label className="field">
              Brand
              <select className="input" value={clientId} disabled={!!id} onChange={(e) => setClientId(e.target.value)}>
                <option value="">Choose a brand…</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {clientId && (
              <div className="stack" style={{ gap: 8 }}>
                <div className="row between">
                  <strong className="small">Channels</strong>
                  <Link to={`/clients/${clientId}`} className="small">
                    Manage channels
                  </Link>
                </div>
                {channels.length ? (
                  <div className="channel-pick">
                    {channels.map((c) => {
                      const on = selected.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={on ? 'on' : ''}
                          disabled={lockedChannelIds.has(c.id)}
                          title={c.status === 'disconnected' ? 'Disconnected: reconnect it to post here' : lockedChannelIds.has(c.id) ? 'Already posted' : ''}
                          onClick={() => setSelected(on ? selected.filter((x) => x !== c.id) : [...selected, c.id])}
                        >
                          <Avatar src={c.avatarUrl} name={c.name} platform={c.platform} size={26} />
                          {c.name}
                          {c.status !== 'ok' && <AlertCircle size={14} color={c.status === 'disconnected' ? 'var(--error)' : 'var(--warning)'} />}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="banner info">
                    <div className="body">
                      This brand has no channels yet. <Link to={`/clients/${clientId}`}>Connect one</Link>.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <div className="tabs" style={{ padding: '0 12px', marginBottom: 0 }}>
              <button className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>
                All channels
              </button>
              {selectedChannels.map((c) => (
                <button key={c.id} className={tab === c.id ? 'on' : ''} onClick={() => setTab(c.id)}>
                  <PlatformBadge platform={c.platform} size={16} /> {c.name}
                  {overrides[c.id] != null && <span className="count">custom</span>}
                </button>
              ))}
            </div>
            <div className="card-body stack">
              {tab !== 'all' && (
                <div className="row between small">
                  <span className="muted">
                    {overrides[tab] != null
                      ? `Custom text for ${platformInfo(selectedChannels.find((c) => c.id === tab)?.platform ?? '').label}.`
                      : 'Uses the main text. Edit below to customise it for this channel.'}
                  </span>
                  {overrides[tab] != null && (
                    <button
                      className="btn ghost sm"
                      onClick={() => {
                        const { [tab]: _, ...rest } = overrides;
                        setOverrides(rest);
                      }}
                    >
                      Use main text
                    </button>
                  )}
                </div>
              )}
              <textarea
                className="input"
                rows={8}
                placeholder="What do you want to say?"
                value={editingText}
                onChange={(e) => (tab === 'all' ? setBody(e.target.value) : setOverrides({ ...overrides, [tab]: e.target.value }))}
                aria-label="Post text"
              />
              <div className="row between">
                <div className="row" style={{ gap: 14 }}>
                  {(tab === 'all' ? checks : tabCheck ? [tabCheck] : []).map((c) => (
                    <span key={c.channelId} className={`counter row ${c.count > c.max ? 'over' : ''}`} style={{ gap: 4 }} title={channels.find((x) => x.id === c.channelId)?.name}>
                      <PlatformBadge platform={c.platform} size={14} />
                      {c.max - c.count}
                    </span>
                  ))}
                </div>
                <SnippetPicker
                  snippets={snippets.data?.snippets ?? []}
                  clientId={clientId}
                  onPick={(t) => {
                    const add = (s: string) => `${s.trimEnd()}${s.trim() ? '\n\n' : ''}${t}`;
                    if (tab === 'all') setBody(add(body));
                    else setOverrides({ ...overrides, [tab]: add(textFor(tab)) });
                  }}
                />
              </div>
              {tab === 'all' && (
                <Extras
                  platforms={[...new Set(selectedChannels.map((c) => c.platform))]}
                  body={body}
                  setBody={setBody}
                  thread={thread}
                  setThread={setThread}
                  firstComment={firstComment}
                  setFirstComment={setFirstComment}
                  recycle={recycle}
                  setRecycle={setRecycle}
                />
              )}

              <div className="stack" style={{ gap: 8 }}>
                <div className="thumbs">
                  {media.map((m) => (
                    <div key={m.id} className="thumb">
                      <MediaThumb m={m} />
                      {m.storage === 'drive' && (
                        <span className="drive" title="Saved in your Google Drive">
                          Drive
                        </span>
                      )}
                      <button className="x" type="button" onClick={() => setMedia(media.filter((x) => x.id !== m.id))} aria-label="Remove media">
                        <X size={13} />
                      </button>
                      {ai.data?.enabled && (
                        <AltTextButton
                          mediaId={m.id}
                          clientId={clientId}
                          text={body}
                          onAlt={(alt) => {
                            api(`/media/${m.id}`, { method: 'PATCH', body: { alt } });
                            setMedia(media.map((x) => (x.id === m.id ? { ...x, alt } : x)));
                          }}
                        />
                      )}
                      <input
                        key={m.alt}
                        placeholder="Alt text"
                        defaultValue={m.alt}
                        onBlur={(e) => {
                          const alt = e.target.value;
                          api(`/media/${m.id}`, { method: 'PATCH', body: { alt } });
                          setMedia(media.map((x) => (x.id === m.id ? { ...x, alt } : x)));
                        }}
                        aria-label="Alt text"
                      />
                    </div>
                  ))}
                </div>
                <div
                  className={`dropzone ${drag ? 'drag' : ''}`}
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDrag(true);
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    upload(e.dataTransfer.files);
                  }}
                >
                  {uploading ? <Spinner /> : <ImagePlus size={18} style={{ verticalAlign: -4 }} />} Add images or a video (drop or click). Images up to 10 MB; MP4, MOV or WebM video up to 100 MB.
                  <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
                </div>
              </div>
            </div>
          </div>

          {ai.data && clientId && (
            <Assistant
              status={ai.data}
              clientId={clientId}
              platforms={[...new Set(selectedChannels.map((c) => c.platform))]}
              text={editingText}
              onUse={(t) => (tab === 'all' ? setBody(t) : setOverrides({ ...overrides, [tab]: t }))}
              onAppend={(t) => {
                const add = (s: string) => `${s.trimEnd()}${s.trim() ? '\n\n' : ''}${t}`;
                if (tab === 'all') setBody(add(body));
                else setOverrides({ ...overrides, [tab]: add(textFor(tab)) });
              }}
              onAdapt={(versions) => {
                const next = { ...overrides };
                for (const c of selectedChannels) {
                  const v = versions.find((x) => x.platform === c.platform);
                  if (v?.text) next[c.id] = v.text;
                }
                setOverrides(next);
                toast('Each channel now has its own version. Check them in the tabs above.');
              }}
            />
          )}

          <div className="card pad stack">
            <div className="row between">
              <h3>When</h3>
              <span className="small muted">{client ? `${client.name}'s time zone: ${tz.replace(/_/g, ' ')}` : ''}</span>
            </div>
            <div className="row">
              <input className="input" type="date" style={{ width: 'auto' }} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
              <input className="input" type="time" style={{ width: 'auto' }} value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" />
              {client?.approvalRequired && <span className="pill awaiting_approval">Needs approval</span>}
            </div>
            <ErrorBanner error={error} />
            <div className="row">
              <button className="btn primary" disabled={!!busy || !clientId || !date || !selected.length || hasIssues} onClick={() => save('schedule')}>
                {busy === 'schedule' && <Spinner />} {client?.approvalRequired ? 'Send for approval' : 'Schedule'}
              </button>
              {!client?.approvalRequired && (
                <button className="btn accent" disabled={!!busy || !clientId || !selected.length || hasIssues} onClick={() => save('now')}>
                  {busy === 'now' ? <Spinner /> : <Send size={15} />} Post now
                </button>
              )}
              {!!client?.queueSlots?.length && (
                <button className="btn" disabled={!!busy || !selected.length || hasIssues} onClick={() => save('queue')} title="Next free posting time for this brand">
                  {busy === 'queue' ? <Spinner /> : <CalendarPlus size={15} />} Add to queue
                </button>
              )}
              <button className="btn" disabled={!!busy || !clientId} onClick={() => save('draft')}>
                {busy === 'draft' && <Spinner />} Save draft
              </button>
            </div>
          </div>
        </div>

        <aside className="stack">
          <h3>Preview</h3>
          {selectedChannels.length ? (
            selectedChannels.map((c) => {
              const check = checks.find((x) => x.channelId === c.id);
              return (
                <div key={c.id} className="preview">
                  <div className="who">
                    <Avatar src={c.avatarUrl} name={c.name} platform={c.platform} />
                    <div>
                      <strong className="small">{c.name}</strong>
                      <div className="tiny muted">
                        {c.handle} · {platformInfo(c.platform).label}
                      </div>
                    </div>
                  </div>
                  <div className="text">{textFor(c.id) || <span className="muted">Your text appears here.</span>}</div>
                  {!!media.length && (
                    <div className="imgs" style={{ gridTemplateColumns: media.length > 1 ? '1fr 1fr' : '1fr' }}>
                      {media.slice(0, 4).map((m) => (
                        <MediaThumb key={m.id} m={m} />
                      ))}
                    </div>
                  )}
                  {check?.issues.map((i) => (
                    <div key={i} className="issue" style={{ marginTop: 8 }}>
                      <AlertCircle size={14} style={{ flex: 'none', marginTop: 2 }} /> {i}
                    </div>
                  ))}
                  {check?.warnings?.map((i) => (
                    <div key={i} className="issue" style={{ marginTop: 8, color: 'var(--warning)' }}>
                      <AlertCircle size={14} style={{ flex: 'none', marginTop: 2 }} /> Brand guard: {i}
                    </div>
                  ))}
                  {c.status === 'disconnected' && (
                    <div className="issue" style={{ marginTop: 8 }}>
                      <AlertCircle size={14} style={{ flex: 'none', marginTop: 2 }} /> This channel is disconnected. The post will wait until you reconnect it.
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="card">
              <Empty title="Pick a channel">Previews for each network appear here.</Empty>
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
