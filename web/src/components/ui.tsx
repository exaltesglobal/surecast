import { Loader2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { platformInfo, STATUS_LABEL } from '../lib/platforms';

export function Pill({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`pill ${status}`}>{children ?? STATUS_LABEL[status] ?? status}</span>;
}

export function PlatformBadge({ platform, size = 22 }: { platform: string; size?: number }) {
  const p = platformInfo(platform);
  return (
    <span className="plat-badge" style={{ background: p.color, width: size, height: size, fontSize: size * 0.45 }} title={p.label}>
      {p.short}
    </span>
  );
}

export function Avatar({ src, name, platform, size = 32 }: { src?: string | null; name: string; platform?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const p = platform ? platformInfo(platform) : null;
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      {src && !broken ? <img src={src} alt="" onError={() => setBroken(true)} /> : <span style={{ fontWeight: 700, fontSize: size * 0.4 }}>{name.replace(/^@/, '').slice(0, 1).toUpperCase()}</span>}
      {p && (
        <span className="plat" style={{ background: p.color }}>
          {p.short.slice(0, 1)}
        </span>
      )}
    </span>
  );
}

export const Spinner = ({ size = 16 }: { size?: number }) => <Loader2 size={size} className="spin" />;

export function Loading() {
  return (
    <div className="empty">
      <Spinner size={22} />
    </div>
  );
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div style={{ marginBottom: 10, color: 'var(--accent)' }}>{icon}</div>}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="card-body stack">{children}</div>
        {footer && <div className="card-head row" style={{ borderTop: '1px solid var(--line)', borderBottom: 0, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

/** Loads data on mount (and when deps change), with a reload function. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

type Toast = { text: string; kind: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number>(0);
  const show = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    setToast({ text, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.kind === 'error' ? 'error' : ''}`} role="status">
          {toast.text}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function CopyField({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="copy">
      <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} />
      <button
        className="btn sm"
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(value);
          toast('Copied');
        }}
      >
        Copy
      </button>
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="banner error">
      <div className="body">{error}</div>
    </div>
  );
}
