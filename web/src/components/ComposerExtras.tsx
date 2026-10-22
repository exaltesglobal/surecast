import { ListPlus, MessageSquare, Plus, Repeat, Scissors, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { THREADS, platformInfo } from '../lib/platforms';
import type { Snippet } from '../lib/types';

/** Splits long text into thread parts at sentence or word boundaries. */
export function splitIntoThread(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  const room = max - 6; // leaves space for a " (1/9)" counter if people add one
  while (rest.length > room) {
    const window = rest.slice(0, room);
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. ') + 1, window.lastIndexOf('! ') + 1, window.lastIndexOf('? ') + 1);
    const at = cut > room * 0.4 ? cut : window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : room;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function Extras(props: {
  platforms: string[];
  body: string;
  setBody: (v: string) => void;
  thread: string[];
  setThread: (v: string[]) => void;
  firstComment: string;
  setFirstComment: (v: string) => void;
  recycle: { days: number; times: number };
  setRecycle: (v: { days: number; times: number }) => void;
}) {
  const { platforms, thread, setThread } = props;
  const [open, setOpen] = useState(() => ({ thread: thread.length > 0, comment: !!props.firstComment, recycle: props.recycle.days > 0 }));
  const threadNets = platforms.filter((p) => THREADS.includes(p));
  const commentOnly = platforms.filter((p) => !THREADS.includes(p));
  const tightest = threadNets.length ? Math.min(...threadNets.map((p) => ({ x: 280, bluesky: 300, mastodon: 500, threads: 500, telegram: 4096 })[p as 'x'] ?? 280)) : 280;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className={`btn sm ${open.thread ? 'on' : ''}`} onClick={() => setOpen({ ...open, thread: !open.thread })} disabled={!threadNets.length} title={threadNets.length ? '' : 'Threads work on X, Bluesky, Mastodon, Threads and Telegram'}>
          <ListPlus size={14} /> Thread
        </button>
        <button type="button" className={`btn sm ${open.comment ? 'on' : ''}`} onClick={() => setOpen({ ...open, comment: !open.comment })}>
          <MessageSquare size={14} /> First comment
        </button>
        <button type="button" className={`btn sm ${open.recycle ? 'on' : ''}`} onClick={() => setOpen({ ...open, recycle: !open.recycle })}>
          <Repeat size={14} /> Repeat
        </button>
      </div>

      {open.thread && !!threadNets.length && (
        <div className="extra stack">
          <div className="row between small">
            <strong>Thread</strong>
            <span className="muted tiny">
              Goes to {threadNets.map((p) => platformInfo(p).label).join(', ')}
              {commentOnly.length ? `. ${commentOnly.map((p) => platformInfo(p).label).join(', ')} get the first post only.` : '.'}
            </span>
          </div>
          {props.body.length > tightest && !thread.length && (
            <button
              type="button"
              className="btn sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() => {
                const [first, ...more] = splitIntoThread(props.body, tightest);
                props.setBody(first);
                setThread(more);
              }}
            >
              <Scissors size={14} /> Split the long text into a thread
            </button>
          )}
          {thread.map((part, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <span className="thread-no">{i + 2}</span>
              <textarea className="input" rows={2} value={part} onChange={(e) => setThread(thread.map((p, j) => (j === i ? e.target.value : p)))} aria-label={`Thread part ${i + 2}`} />
              <span className={`tiny ${part.length > tightest ? 'over' : 'muted'}`} style={{ minWidth: 34, textAlign: 'right' }}>
                {tightest - part.length}
              </span>
              <button type="button" className="btn ghost sm" aria-label="Remove part" onClick={() => setThread(thread.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setThread([...thread, ''])}>
            <Plus size={14} /> Add a part
          </button>
        </div>
      )}

      {open.comment && (
        <label className="extra field">
          First comment <span className="hint">Posted under the post right after it goes out. Good for links, hashtags and credits.</span>
          <textarea className="input" rows={2} value={props.firstComment} onChange={(e) => props.setFirstComment(e.target.value)} />
        </label>
      )}

      {open.recycle && (
        <div className="extra stack" style={{ gap: 6 }}>
          <strong className="small">Repeat this post</strong>
          <div className="row small">
            Post it again every
            <input className="input" type="number" min={1} max={365} style={{ width: 80 }} value={props.recycle.days || ''} onChange={(e) => props.setRecycle({ ...props.recycle, days: Number(e.target.value) })} aria-label="Days" />
            days,
            <input className="input" type="number" min={1} max={52} style={{ width: 70 }} value={props.recycle.times || ''} onChange={(e) => props.setRecycle({ ...props.recycle, times: Number(e.target.value) })} aria-label="Times" />
            more times.
          </div>
          <span className="tiny muted">For evergreen content. X refuses identical text, so change the wording a little for X.</span>
        </div>
      )}
    </div>
  );
}

export function SnippetPicker({ snippets, clientId, onPick }: { snippets: Snippet[]; clientId: string; onPick: (text: string) => void }) {
  const mine = snippets.filter((s) => !s.clientId || s.clientId === clientId);
  return (
    <select
      className="input"
      style={{ width: 'auto' }}
      value=""
      onChange={(e) => {
        const s = mine.find((x) => x.id === e.target.value);
        if (s) onPick(s.body);
      }}
      aria-label="Insert a snippet"
    >
      <option value="">Insert snippet…</option>
      {mine.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
      {!mine.length && <option disabled>No snippets yet. Add them in Settings.</option>}
    </select>
  );
}
