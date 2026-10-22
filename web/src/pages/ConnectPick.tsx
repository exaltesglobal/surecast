import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';

import { useApp } from '../components/Layout';
import { Avatar, ErrorBanner, Loading, Spinner, useLoad } from '../components/ui';
import { api } from '../lib/api';

type Pending = { clientId: string; candidates: { index: number; platform: string; name: string; handle: string; avatarUrl: string | null; detail: string | null }[] };

/** After Facebook login: choose which Pages and Instagram accounts to add. */
export function ConnectPick() {
  const { id } = useParams();
  const nav = useNavigate();
  const { reloadClients } = useApp();
  const { data, error } = useLoad(() => api<Pending>(`/pending/${id}`), [id]);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  if (!data) return error ? <ErrorBanner error={error} /> : <Loading />;
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <div className="card-head">
        <h2>Choose accounts to add</h2>
      </div>
      <div className="list">
        {data.candidates.map((c) => (
          <label key={c.index} className="list-item check" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={picked.includes(c.index)} onChange={(e) => setPicked(e.target.checked ? [...picked, c.index] : picked.filter((x) => x !== c.index))} />
            <Avatar src={c.avatarUrl} name={c.name} platform={c.platform} />
            <div className="grow">
              <strong>{c.name}</strong>
              <div className="tiny muted">{c.detail}</div>
            </div>
          </label>
        ))}
      </div>
      <div className="card-body stack">
        <ErrorBanner error={saveError} />
        <button
          className="btn primary"
          disabled={!picked.length || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/pending/${id}`, { body: { indexes: picked } });
              await reloadClients();
              nav(`/clients/${data.clientId}?connected=1`);
            } catch (e) {
              setSaveError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />} Add {picked.length || ''} account{picked.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}
