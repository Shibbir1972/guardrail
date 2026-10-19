'use client';

import { useState } from 'react';
import { Icon, api, ms, useAction } from './ui';

interface Found {
  ok: boolean;
  error?: string;
  url?: string;
  latency?: number;
  models?: { name: string; contextLen: number | null }[];
}

export interface SavedServer {
  id: number;
  name: string;
}

const ctx = (n: number | null) => (n ? (n >= 1024 ? `${Math.round(n / 1024)}k context` : `${n} context`) : 'context unknown');

/** Paste an address, discover its models, tick the ones to use, save. */
export function AddServer({ role = 'inference', onSaved, compact }: { role?: 'inference' | 'guard'; onSaved: (s: SavedServer) => void; compact?: boolean }) {
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [asRole, setAsRole] = useState<'inference' | 'guard'>(role);
  const { run, busy } = useAction();

  const find = () =>
    run(async () => {
      const r = await api<Found>('servers/discover', { body: { url, apiKey: key } });
      setFound(r);
      if (r.ok) {
        setPicked(new Set(r.models?.map((m) => m.name)));
        if (!name) {
          try {
            setName(new URL(r.url!).hostname.replace(/\./g, '-'));
          } catch {
            setName('server');
          }
        }
      }
    });

  const save = () =>
    run(async () => {
      const s = await api<SavedServer>('servers', { body: { name, url: found?.url ?? url, apiKey: key, role: asRole, models: found?.models ?? [], enabled: [...picked], latency: found?.latency } });
      setFound(null);
      setUrl('');
      setKey('');
      setName('');
      onSaved(s);
    }, 'Server saved');

  return (
    <div className="stack" style={{ gap: 12 }}>
      <form
        className="wrap"
        style={{ gap: 10, alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label style={{ flex: compact ? '2 1 220px' : '3 1 320px' }}>
          <span className="lbl">vLLM address</span>
          <input className="inp mono" type="text" placeholder="http://10.0.1.5:8000" value={url} onChange={(e) => setUrl(e.target.value)} required />
        </label>
        <label style={{ flex: '1 1 180px' }}>
          <span className="lbl">Server API key (optional)</span>
          <input className="inp mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        </label>
        <button type="submit" className="btn pri" style={{ minHeight: 44 }} disabled={busy || !url.trim()}>
          <Icon name="search" stroke={2.2} />
          {busy && !found ? 'Looking…' : 'Discover models'}
        </button>
      </form>
      {found && !found.ok && (
        <div className="wrap small">
          <span className="pill bad">Could not connect</span>
          <span className="muted">{found.error}. Check the address and that vLLM is running with its OpenAI server.</span>
        </div>
      )}
      {found?.ok && (
        <div className="stack">
          <div className="wrap small" style={{ gap: 10 }}>
            <span className="pill ok">Connected · {ms(found.latency)}</span>
            <span className="muted">
              Found {found.models!.length} model{found.models!.length === 1 ? '' : 's'}. Pick the ones {asRole === 'guard' ? 'the guard checks may use' : 'clients may use'}.
            </span>
          </div>
          {found.models!.map((m) => (
            <label key={m.name} className="found">
              <input
                type="checkbox"
                checked={picked.has(m.name)}
                onChange={(e) => {
                  const n = new Set(picked);
                  if (e.target.checked) n.add(m.name);
                  else n.delete(m.name);
                  setPicked(n);
                }}
              />
              <span className="mono" style={{ fontWeight: 500, flex: '1 1 200px' }}>
                {m.name}
              </span>
              <span className="muted">{ctx(m.contextLen)}</span>
            </label>
          ))}
          <div className="wrap" style={{ justifyContent: 'flex-end' }}>
            {role === 'inference' && (
              <div className="seg" role="group" aria-label="Server use">
                <button type="button" className={asRole === 'inference' ? 'on' : ''} onClick={() => setAsRole('inference')}>
                  For clients
                </button>
                <button type="button" className={asRole === 'guard' ? 'on' : ''} onClick={() => setAsRole('guard')}>
                  Guard models only
                </button>
              </div>
            )}
            <input className="inp" style={{ width: 220, minHeight: 40 }} type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Server name" placeholder="Server name" />
            <button type="button" className="btn blk" onClick={save} disabled={busy || !name.trim()}>
              Save server
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
