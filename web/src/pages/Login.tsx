import { CheckCircle2 } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { ErrorBanner, Spinner } from '../components/ui';
import { api } from '../lib/api';

export function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (step === 'email') {
        await api('/auth/code', { body: { email } });
        setStep('code');
      } else {
        await api('/auth/verify', { body: { email, code, name } });
        nav(params.get('next') || '/', { replace: true });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <section className="pitch">
        <div className="brand" style={{ padding: 0 }}>
          <img src="/mark-white.svg" alt="" />
          <span>
            Surecast<span className="dot">.</span>
          </span>
        </div>
        <div>
          <h1>
            Every post goes out. <span>Or you know why.</span>
          </h1>
          <ul>
            {[
              'Automatic retries when a network hiccups, so a blip never becomes a missed post.',
              'Pre-flight checks 15 minutes before each slot, and an email the moment anything breaks.',
              'Client approvals and proof-of-publish reports, with no seats to pay for.',
              'Flat pricing for agencies. Add clients without watching the bill climb.',
            ].map((t) => (
              <li key={t}>
                <CheckCircle2 size={18} />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p style={{ color: '#9aa1ad', fontSize: 13 }}>© {new Date().getFullYear()} Surecast · Agape Labs</p>
      </section>
      <section className="form">
        <form className="card stack" onSubmit={submit}>
          <h2>{step === 'email' ? 'Sign in or create an account' : 'Check your email'}</h2>
          {step === 'email' ? (
            <>
              <p className="muted">We'll email you a 6-digit code. No password needed.</p>
              <label className="field">
                Work email
                <input className="input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
            </>
          ) : (
            <>
              <p className="muted">
                We sent a code to <strong>{email}</strong>.
              </p>
              <label className="field">
                Code
                <input className="input mono" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </label>
              <label className="field">
                Your name <span className="hint">Only needed the first time.</span>
                <input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </>
          )}
          <ErrorBanner error={error} />
          <button className="btn primary block" disabled={busy}>
            {busy && <Spinner />} {step === 'email' ? 'Email me a code' : 'Sign in'}
          </button>
          {step === 'code' && (
            <button type="button" className="btn ghost sm" onClick={() => setStep('email')}>
              Use a different email
            </button>
          )}
        </form>
      </section>
    </div>
  );
}
