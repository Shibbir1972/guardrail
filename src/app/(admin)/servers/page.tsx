'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AddServer } from '@/components/add-server';
import { Icon, Loading, Modal, PageHead, Switch, api, ago, ms, useAction, useApi } from '@/components/ui';
import type { LimitView } from '@/lib/limits';
import type { Model, Server } from '@/lib/servers';

type ServerV = Server & { hasKey: boolean; models: Model[] };
interface GroupV {
  id: number;
  name: string;
  depth: number;
}
interface Data {
  servers: ServerV[];
  limits: LimitView[];
  groups: GroupV[];
  access: Record<string, string[]>;
}

const ctx = (n: number | null) => (n ? (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n)) : '–');

export default function ServersPage() {
  const { data, error, reload } = useApi<Data>('servers');
  const [limitFor, setLimitFor] = useState<Partial<LimitView> | null>(null);
  const [edit, setEdit] = useState<ServerV | null>(null);

  return (
    <>
      <PageHead step="Step 1 of 5" title="Servers and models" sub="Paste a vLLM server address. GuardRail finds the models it serves on its own.">
        <Link href="/groups" className="btn blk">
          Next: groups
        </Link>
      </PageHead>
      <div className="content">
        <section className="card">
          <div className="hd" style={{ marginBottom: 12 }}>
            <h2>Add a server</h2>
          </div>
          <AddServer onSaved={() => void reload()} />
        </section>
        {!data ? (
          <Loading error={error} />
        ) : (
          <div className="row">
            <div className="col" style={{ flex: '999 1 560px' }}>
              {data.servers.length === 0 && <div className="card empty">No servers yet. Add your first vLLM server above.</div>}
              {data.servers.map((s) => (
                <ServerCard key={s.id} s={s} data={data} reload={reload} onRule={(l) => setLimitFor(l)} onEdit={() => setEdit(s)} />
              ))}
            </div>
            <Limits data={data} onAdd={(l) => setLimitFor(l)} reload={reload} />
          </div>
        )}
      </div>
      {limitFor && data && <LimitModal init={limitFor} data={data} onClose={() => setLimitFor(null)} onSaved={() => { setLimitFor(null); void reload(); }} />}
      {edit && <EditServer s={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </>
  );
}

function ServerCard({ s, data, reload, onRule, onEdit }: { s: ServerV; data: Data; reload: () => void; onRule: (l: Partial<LimitView>) => void; onEdit: () => void }) {
  const { run, busy } = useAction();
  const serverRule = data.limits.find((l) => l.scope === 'server' && l.server_id === s.id);
  const status = s.status === 'online' ? ['ok', `Online · ${ms(s.latency_ms)}`] : s.status === 'down' ? ['bad', 'Down'] : ['', 'Not checked'];
  return (
    <section className="card stack" style={{ gap: 12 }}>
      <div className="between">
        <div className="wrap" style={{ gap: 12 }}>
          <div className="srv-ico">
            <Icon name="server" size={20} />
          </div>
          <div>
            <div style={{ fontWeight: 700 }}>{s.name}</div>
            <div className="mono muted">{s.url}</div>
          </div>
        </div>
        <div className="wrap">
          <span className={`pill ${status[0]}`} title={s.last_error ?? `Checked ${ago(s.last_checked)}`}>
            {status[1]}
          </span>
          {s.role === 'guard' ? <span className="pill">Guard models, not for clients</span> : serverRule ? <span className="pill warn">Server rule</span> : <span className="pill">{s.models.length} models</span>}
          <button type="button" className="btn sm" disabled={busy} onClick={() => run(async () => {
            const r = await api<{ ok: boolean; error?: string; found?: number; newModels?: number }>(`servers/${s.id}/rediscover`, { body: {} });
            reload();
            if (!r.ok) throw new Error(`Could not reach ${s.name}: ${r.error}`);
            return r;
          }, 'Models refreshed')}>
            <Icon name="refresh" size={14} />
            Rediscover
          </button>
          {s.role === 'inference' && (
            <button type="button" className="btn sm" onClick={() => onRule(serverRule ?? { scope: 'server', server_id: s.id })}>
              Server rule
            </button>
          )}
          <button type="button" className="btn sm" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
      {s.status === 'down' && s.last_error && <div className="small" style={{ color: 'var(--bad)' }}>{s.last_error}</div>}
      <div className="scroll-x">
        <div style={{ minWidth: 640 }}>
          <div className="mrow head">
            <span>Model (found automatically)</span>
            <span>Context</span>
            <span>{s.role === 'guard' ? 'Used for' : 'Groups that can use it'}</span>
            <span>Rule</span>
            <span>{s.role === 'guard' ? 'On' : 'Clients'}</span>
          </div>
          {s.models.length === 0 && <div className="mrow muted">No models found. Click Rediscover once vLLM is up.</div>}
          {s.models.map((m) => {
            const rule = data.limits.find((l) => l.scope === 'model' && l.server_id === s.id && l.model_name === m.name);
            const groups = data.access[m.id] ?? [];
            return (
              <div className="mrow" key={m.id}>
                <span className="mono" style={{ fontWeight: 500, fontSize: 12.5 }}>
                  {m.name} {!m.present && <span className="pill bad">Gone from server</span>}
                </span>
                <span className="muted">{ctx(m.context_len)}</span>
                <span className="small">{s.role === 'guard' ? 'Guard checks (set in Guard checks)' : m.enabled ? groups.join(', ') || <span className="muted">No group yet</span> : <span className="muted">Hidden from clients</span>}</span>
                <span>
                  {s.role === 'guard' ? (
                    <span className="pill">Hidden from clients</span>
                  ) : (
                    <button type="button" className={`pill ${rule ? 'info' : ''}`} style={{ border: 0, cursor: 'pointer' }} onClick={() => onRule(rule ?? { scope: 'model', server_id: s.id, model_name: m.name })}>
                      {rule ? describe(rule, data) : serverRule ? 'Server rule' : 'Global rules'}
                    </button>
                  )}
                </span>
                <Switch on={!!m.enabled} label={`Let clients use ${m.name}`} onChange={(v) => run(async () => { await api(`models/${m.id}`, { method: 'PATCH', body: { enabled: v } }); reload(); })} />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function describe(l: LimitView, data: Data) {
  const parts: string[] = [];
  if (l.allowedGroups?.length) parts.push(`${l.allowedGroups.map((id) => data.groups.find((g) => g.id === id)?.name ?? '?').join(', ')} only`);
  if (l.rate_limit) parts.push(`${l.rate_limit} requests/min`);
  return parts.join(' · ') || l.note || 'No limit set';
}

function Limits({ data, onAdd, reload }: { data: Data; onAdd: (l: Partial<LimitView>) => void; reload: () => void }) {
  const { run } = useAction();
  const global = data.limits.find((l) => l.scope === 'global');
  const servers = data.limits.filter((l) => l.scope === 'server');
  const models = data.limits.filter((l) => l.scope === 'model');
  const sname = (id: number | null) => data.servers.find((s) => s.id === id)?.name ?? '?';
  const del = (id: number) => run(async () => { await api(`limits/${id}`, { method: 'DELETE' }); reload(); }, 'Rule removed');
  return (
    <aside className="card stack" style={{ flex: '1 1 300px', gap: 14 }}>
      <div>
        <h2>Where a rule applies</h2>
        <div className="muted small" style={{ marginTop: 2 }}>
          Set a rule for all servers, one server or one model. The narrowest one wins.
        </div>
      </div>
      <div className="nest l0">
        <div className="between">
          <b className="small">All servers</b>
          <span className="pill">Global</span>
        </div>
        <button type="button" className="btn textlike" onClick={() => onAdd(global ?? { scope: 'global' })}>
          <span className="muted small">{global ? describe(global, data) : 'No global limit. Group rate limits still apply.'}</span>
        </button>
        {servers.map((l) => (
          <div className="nest l1" key={l.id}>
            <div className="between">
              <b className="small">One server: {sname(l.server_id)}</b>
              <span className="wrap">
                <span className="pill">Server</span>
                <button type="button" className="btn sm ghost" aria-label="Remove rule" onClick={() => del(l.id)}><Icon name="x" size={14} /></button>
              </span>
            </div>
            <button type="button" className="btn textlike" onClick={() => onAdd(l)}>
              <span className="muted small">{describe(l, data)}</span>
            </button>
            {models.filter((m) => m.server_id === l.server_id).map((m) => <ModelNest key={m.id} m={m} data={data} onEdit={onAdd} onDel={del} />)}
          </div>
        ))}
        {models.filter((m) => !servers.some((s) => s.server_id === m.server_id)).map((m) => <ModelNest key={m.id} m={m} data={data} onEdit={onAdd} onDel={del} server={sname(m.server_id)} />)}
      </div>
      <button type="button" className="btn dash" onClick={() => onAdd({ scope: 'model' })}>
        + Add a rule
      </button>
      <div className="muted" style={{ fontSize: 12 }}>
        Who may use a server or model is set on <Link href="/groups">groups</Link>. These rules are limits that apply on top, to everyone.
      </div>
    </aside>
  );
}

function ModelNest({ m, data, onEdit, onDel, server }: { m: LimitView; data: Data; onEdit: (l: LimitView) => void; onDel: (id: number) => void; server?: string }) {
  return (
    <div className="nest l2">
      <div className="between">
        <b className="small">
          One model: {m.model_name}
          {server ? ` on ${server}` : ''}
        </b>
        <span className="wrap">
          <span className="pill info">Model</span>
          <button type="button" className="btn sm ghost" aria-label="Remove rule" onClick={() => onDel(m.id)}><Icon name="x" size={14} /></button>
        </span>
      </div>
      <button type="button" className="btn textlike" onClick={() => onEdit(m)}>
        <span className="small" style={{ color: '#3E3A66' }}>{describe(m, data)}</span>
      </button>
    </div>
  );
}

function LimitModal({ init, data, onClose, onSaved }: { init: Partial<LimitView>; data: Data; onClose: () => void; onSaved: () => void }) {
  const [scope, setScope] = useState<LimitView['scope']>(init.scope ?? 'model');
  const inference = data.servers.filter((s) => s.role === 'inference');
  const [serverId, setServerId] = useState<number | null>(init.server_id ?? inference[0]?.id ?? null);
  const [model, setModel] = useState(init.model_name ?? '');
  const [rate, setRate] = useState(init.rate_limit ? String(init.rate_limit) : '');
  const [groups, setGroups] = useState<number[]>(init.allowedGroups ?? []);
  const { run, busy } = useAction();
  const models = inference.find((s) => s.id === serverId)?.models ?? [];
  return (
    <Modal title={init.id ? 'Edit rule' : 'Add a rule'} onClose={onClose}>
      <div>
        <span className="lbl">Applies to</span>
        <div className="seg">
          {(['global', 'server', 'model'] as const).map((s) => (
            <button key={s} type="button" className={scope === s ? 'on' : ''} onClick={() => setScope(s)}>
              {s === 'global' ? 'All servers' : s === 'server' ? 'One server' : 'One model'}
            </button>
          ))}
        </div>
      </div>
      {scope !== 'global' && (
        <label>
          <span className="lbl">Server</span>
          <select className="inp" value={serverId ?? ''} onChange={(e) => { setServerId(Number(e.target.value)); setModel(''); }}>
            {inference.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
      )}
      {scope === 'model' && (
        <label>
          <span className="lbl">Model</span>
          <select className="inp" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">Pick a model</option>
            {models.map((m) => (
              <option key={m.id} value={m.name}>{m.name}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        <span className="lbl">Rate limit per key (requests per minute, empty for none)</span>
        <input className="inp" type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} />
      </label>
      <div>
        <span className="lbl">Only these groups (and their sub-groups). None ticked means every group.</span>
        <div className="stack" style={{ gap: 2 }}>
          {data.groups.map((g) => (
            <label key={g.id} className="chk" style={{ paddingLeft: g.depth * 18 }}>
              <input type="checkbox" checked={groups.includes(g.id)} onChange={(e) => setGroups(e.target.checked ? [...groups, g.id] : groups.filter((x) => x !== g.id))} />
              {g.name}
            </label>
          ))}
        </div>
      </div>
      <div className="wrap" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn pri" disabled={busy} onClick={() => run(async () => {
          await api('limits', { body: { id: init.id, scope, serverId, modelName: model, rateLimit: rate ? Number(rate) : null, allowedGroups: groups } });
          onSaved();
        }, 'Rule saved')}>
          Save rule
        </button>
      </div>
    </Modal>
  );
}

function EditServer({ s, onClose, onSaved }: { s: ServerV; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(s.name);
  const [url, setUrl] = useState(s.url);
  const [key, setKey] = useState('');
  const [role, setRole] = useState(s.role);
  const { run, busy } = useAction();
  return (
    <Modal title={`Edit ${s.name}`} onClose={onClose}>
      <label><span className="lbl">Name</span><input className="inp" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label><span className="lbl">Address</span><input className="inp mono" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
      <label><span className="lbl">{s.hasKey ? 'New API key (leave empty to keep the current one)' : 'API key (optional)'}</span><input className="inp mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /></label>
      <div>
        <span className="lbl">Used for</span>
        <div className="seg">
          <button type="button" className={role === 'inference' ? 'on' : ''} onClick={() => setRole('inference')}>Client models</button>
          <button type="button" className={role === 'guard' ? 'on' : ''} onClick={() => setRole('guard')}>Guard models only</button>
        </div>
      </div>
      <div className="between">
        <button type="button" className="btn danger" disabled={busy} onClick={() => confirm(`Delete ${s.name}? Its models and rules go with it.`) && run(async () => { await api(`servers/${s.id}`, { method: 'DELETE' }); onSaved(); }, 'Server deleted')}>
          <Icon name="trash" size={14} />
          Delete server
        </button>
        <div className="wrap">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn pri" disabled={busy} onClick={() => run(async () => { await api(`servers/${s.id}`, { method: 'PATCH', body: { name, url, role, ...(key ? { apiKey: key } : {}) } }); onSaved(); }, 'Server updated')}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
