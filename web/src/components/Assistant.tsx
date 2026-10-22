import { Check, Hash, Lightbulb, Shuffle, Sparkles, Wand2 } from 'lucide-react';
import { useState } from 'react';

import { api } from '../lib/api';
import { platformInfo } from '../lib/platforms';
import { ErrorBanner, PlatformBadge, Spinner } from './ui';

export type AiStatus = { enabled: boolean; usedToday: number; dailyLimit: number };
type Variant = { text: string; angle: string; fits: boolean };
type Version = { platform: string; text: string; chars: number; max: number; fits: boolean };
type Review = { verdict: 'ready' | 'minor' | 'fix'; summary: string; issues: { severity: string; problem: string; fix: string }[] };
type Idea = { title: string; angle: string; format: string };

const REWRITES: [string, string][] = [
  ['shorter', 'Shorter'],
  ['punchier', 'Punchier'],
  ['hook', 'Better hook'],
  ['friendlier', 'Friendlier'],
  ['professional', 'More professional'],
  ['cta', 'Add a call to action'],
  ['emoji', 'Add emoji'],
  ['noemoji', 'Remove emoji'],
  ['fix', 'Fix spelling and grammar'],
];

type Tab = 'write' | 'rewrite' | 'hashtags' | 'adapt' | 'review' | 'ideas';

/**
 * The writing assistant in the composer. It never changes the post on its own:
 * every suggestion has a button to use it.
 */
export function Assistant(props: {
  status: AiStatus;
  clientId: string;
  platforms: string[];
  text: string;
  onUse: (text: string) => void;
  onAppend: (text: string) => void;
  onAdapt: (versions: Version[]) => void;
}) {
  const { clientId, platforms, text } = props;
  const [tab, setTab] = useState<Tab>(text.trim() ? 'rewrite' : 'write');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [used, setUsed] = useState(props.status.usedToday);

  const [brief, setBrief] = useState('');
  const [length, setLength] = useState('medium');
  const [tone, setTone] = useState('');
  const [variants, setVariants] = useState<Variant[]>([]);
  const [rewritten, setRewritten] = useState<{ text: string; fits: boolean } | null>(null);
  const [custom, setCustom] = useState('');
  const [language, setLanguage] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [topic, setTopic] = useState('');
  const [ideas, setIdeas] = useState<Idea[]>([]);

  if (!props.status.enabled)
    return (
      <div className="card pad small muted row" style={{ gap: 8 }}>
        <Sparkles size={16} /> The writing assistant is off. An admin can switch it on by setting ANTHROPIC_API_KEY on the server.
      </div>
    );

  const run = async <T,>(name: string, path: string, payload: Record<string, unknown>, done: (r: T) => void) => {
    setBusy(name);
    setError(null);
    try {
      done(await api<T>(path, { body: { clientId, platforms, ...payload } }));
      setUsed((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const needText = !text.trim();
  const go = (t: Tab) => {
    setTab(t);
    setError(null);
  };

  return (
    <section className="card assistant">
      <div className="card-head">
        <h3 className="row" style={{ gap: 6 }}>
          <Sparkles size={17} color="var(--tangerine)" /> Writing assistant
        </h3>
        <span className="tiny muted">
          {used} of {props.status.dailyLimit} today
        </span>
      </div>
      <div className="tabs" style={{ padding: '0 12px', marginBottom: 0 }}>
        {(
          [
            ['write', 'Write'],
            ['rewrite', 'Rewrite'],
            ['adapt', 'Adapt per network'],
            ['hashtags', 'Hashtags'],
            ['review', 'Review'],
            ['ideas', 'Ideas'],
          ] as [Tab, string][]
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="card-body stack">
        {tab === 'write' && (
          <>
            <label className="field">
              What's the post about?
              <textarea className="input" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="New autumn menu launches Friday. Pumpkin croissant, chai latte. 10% off for the first 50 customers." />
            </label>
            <div className="row">
              <select className="input" style={{ width: 'auto' }} value={length} onChange={(e) => setLength(e.target.value)} aria-label="Length">
                <option value="short">Short</option>
                <option value="medium">Medium</option>
                <option value="long">Long</option>
              </select>
              <input className="input" style={{ flex: 1, minWidth: 160 }} value={tone} onChange={(e) => setTone(e.target.value)} placeholder="Tone (optional), e.g. playful" aria-label="Tone" />
              <button className="btn primary" disabled={!brief.trim() || !!busy} onClick={() => run<{ posts: Variant[] }>('write', '/ai/write', { brief, length, tone, count: 3 }, (r) => setVariants(r.posts))}>
                {busy === 'write' ? <Spinner /> : <Wand2 size={15} />} Write 3 options
              </button>
            </div>
            {variants.map((v, i) => (
              <Suggestion key={i} label={v.angle} warn={!v.fits ? 'Too long for at least one channel' : undefined} text={v.text} onUse={() => props.onUse(v.text)} />
            ))}
          </>
        )}

        {tab === 'rewrite' && (
          <>
            {needText && <p className="small muted">Write or paste the post above first.</p>}
            <div className="row" style={{ gap: 6 }}>
              {REWRITES.map(([k, label]) => (
                <button key={k} className="btn sm" disabled={needText || !!busy} onClick={() => run<{ text: string; fits: boolean }>(k, '/ai/edit', { text, action: k }, setRewritten)}>
                  {busy === k && <Spinner size={13} />} {label}
                </button>
              ))}
            </div>
            <div className="row">
              <input className="input" style={{ flex: 1, minWidth: 160 }} value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="Language, e.g. Hindi" aria-label="Translate to" />
              <button className="btn sm" disabled={needText || !language.trim() || !!busy} onClick={() => run<{ text: string; fits: boolean }>('translate', '/ai/edit', { text, action: 'translate', language }, setRewritten)}>
                {busy === 'translate' && <Spinner size={13} />} Translate
              </button>
            </div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                run<{ text: string; fits: boolean }>('custom', '/ai/edit', { text, action: 'custom', instruction: custom }, setRewritten);
              }}
            >
              <input className="input" style={{ flex: 1, minWidth: 160 }} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Or say what to change, e.g. mention free parking" aria-label="Custom instruction" />
              <button className="btn sm" disabled={needText || !custom.trim() || !!busy}>
                {busy === 'custom' && <Spinner size={13} />} Rewrite
              </button>
            </form>
            {rewritten && <Suggestion text={rewritten.text} warn={!rewritten.fits ? 'Too long for at least one channel' : undefined} onUse={() => (props.onUse(rewritten.text), setRewritten(null))} />}
          </>
        )}

        {tab === 'adapt' && (
          <>
            <p className="small muted">Rewrites the main text for each selected network: its length limit, tone and hashtag habits. Each version becomes that channel's custom text, which you can still edit.</p>
            <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={needText || !platforms.length || !!busy} onClick={() => run<{ versions: Version[] }>('adapt', '/ai/adapt', { text }, (r) => setVersions(r.versions))}>
              {busy === 'adapt' ? <Spinner /> : <Shuffle size={15} />} Adapt for {platforms.length || 'no'} network{platforms.length === 1 ? '' : 's'}
            </button>
            {!!versions.length && (
              <>
                {versions.map((v) => (
                  <div key={v.platform} className="suggestion">
                    <div className="row between tiny muted">
                      <span className="row" style={{ gap: 5 }}>
                        <PlatformBadge platform={v.platform} size={14} /> {platformInfo(v.platform).label}
                      </span>
                      <span style={{ color: v.fits ? undefined : 'var(--error)' }}>
                        {v.chars} / {v.max}
                      </span>
                    </div>
                    <p>{v.text}</p>
                  </div>
                ))}
                <button className="btn accent" style={{ alignSelf: 'flex-start' }} onClick={() => (props.onAdapt(versions), setVersions([]))}>
                  <Check size={15} /> Use these versions
                </button>
              </>
            )}
          </>
        )}

        {tab === 'hashtags' && (
          <>
            <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={needText || !!busy} onClick={() => run<{ hashtags: string[] }>('tags', '/ai/hashtags', { text, count: 12 }, (r) => (setTags(r.hashtags), setPicked([])))}>
              {busy === 'tags' ? <Spinner /> : <Hash size={15} />} Suggest hashtags
            </button>
            {!!tags.length && (
              <>
                <div className="row" style={{ gap: 6 }}>
                  {tags.map((t) => (
                    <button key={t} className={`tag ${picked.includes(t) ? 'on' : ''}`} onClick={() => setPicked(picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t])}>
                      {t}
                    </button>
                  ))}
                </div>
                <button className="btn accent sm" style={{ alignSelf: 'flex-start' }} disabled={!picked.length} onClick={() => (props.onAppend(picked.join(' ')), setPicked([]))}>
                  Add {picked.length || ''} to the post
                </button>
              </>
            )}
          </>
        )}

        {tab === 'review' && (
          <>
            <p className="small muted">A second pair of eyes before you schedule: typos, risky claims, placeholders left in, and anything off-brand.</p>
            <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={needText || !!busy} onClick={() => run<Review>('review', '/ai/review', { text }, setReview)}>
              {busy === 'review' ? <Spinner /> : <Check size={15} />} Review this post
            </button>
            {review && (
              <div className={`banner ${review.verdict === 'ready' ? 'success' : review.verdict === 'minor' ? 'info' : 'warning'}`}>
                <div className="body stack" style={{ gap: 8 }}>
                  <strong>{review.verdict === 'ready' ? 'Looks ready to go' : review.verdict === 'minor' ? 'A few small things' : 'Worth fixing before it goes out'}</strong>
                  <span>{review.summary}</span>
                  {review.issues.map((i, n) => (
                    <div key={n} className="small">
                      <span className={`pill ${i.severity === 'high' ? 'failed' : i.severity === 'medium' ? 'retrying' : 'neutral'}`}>{i.severity}</span> {i.problem} <span className="muted">Fix: {i.fix}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'ideas' && (
          <>
            <div className="row">
              <input className="input" style={{ flex: 1, minWidth: 160 }} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Theme (optional), e.g. Diwali week" aria-label="Theme" />
              <button className="btn" disabled={!clientId || !!busy} onClick={() => run<{ ideas: Idea[] }>('ideas', '/ai/ideas', { topic, count: 8 }, (r) => setIdeas(r.ideas))}>
                {busy === 'ideas' ? <Spinner /> : <Lightbulb size={15} />} Get ideas
              </button>
            </div>
            {ideas.map((i, n) => (
              <div key={n} className="suggestion row between" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <strong className="small">{i.title}</strong> <span className="tiny muted">{i.format}</span>
                  <p className="small">{i.angle}</p>
                </div>
                <button
                  className="btn sm"
                  onClick={() => {
                    setBrief(`${i.title}. ${i.angle}`);
                    go('write');
                  }}
                >
                  Write it
                </button>
              </div>
            ))}
          </>
        )}
        <ErrorBanner error={error} />
      </div>
    </section>
  );
}

function Suggestion({ text, label, warn, onUse }: { text: string; label?: string; warn?: string; onUse: () => void }) {
  return (
    <div className="suggestion">
      {(label || warn) && (
        <div className="row between tiny muted">
          <span>{label}</span>
          {warn && <span style={{ color: 'var(--error)' }}>{warn}</span>}
        </div>
      )}
      <p>{text}</p>
      <button className="btn sm accent" onClick={onUse}>
        <Check size={14} /> Use this
      </button>
    </div>
  );
}

/** Asks the assistant to describe an uploaded image. */
export function AltTextButton({ mediaId, clientId, text, onAlt }: { mediaId: string; clientId: string; text: string; onAlt: (alt: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="describe"
      disabled={busy}
      title="Write alt text with the assistant"
      onClick={async () => {
        setBusy(true);
        try {
          onAlt((await api<{ alt: string }>('/ai/alt-text', { body: { mediaId, clientId, text } })).alt);
        } catch (e) {
          alert((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <Spinner size={12} /> : <Sparkles size={12} />}
    </button>
  );
}
