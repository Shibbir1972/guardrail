'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { display } from '@/components/format-setting';
import { GroupCascade } from '@/components/group-cascade';
import { Icon, Loading, Modal, PageHead, ago, api, copy, fmt, useAction, useApi, useToast } from '@/components/ui';
import type { GroupSettings, Resolution } from '@/lib/groups';
import type { ApiKey } from '@/lib/keys';

interface GroupV {
  id: number;
  name: string;
  parentId: number | null;
  path: string;
  depth: number;
}
type KeyV = ApiKey & { groupName: string; groupPath: string; requestsToday: number };
interface Data {
  keys: KeyV[];
  groups: GroupV[];
}
interface Lookups {
  files: { id: number; name: string; tokens: number }[];
  servers: { id: number; name: string }[];
  models: string[];
}

export default function KeysPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Keys />
    </Suspense>
  );
}

function Keys() {
  const { data, error, reload } = useApi<Data>('keys');
  const look = useApi<Lookups>('groups');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<KeyV | null>(null);
  const { run } = useAction();
  const rows = (data?.keys ?? []).filter((k) => !q || `${k.name} ${k.owner} ${k.groupName} ${k.prefix}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHead step="Step 3 of 5" title="API keys" sub="Each key belongs to one person or bot and one group, so every request can be traced back to them.">
        <Link href="/context" className="btn blk">
          Next: context files
        </Link>
      </PageHead>
      <div className="content">
        {!data || !look.data ? (
          <Loading error={error ?? look.error} />
        ) : (
          <>
            <CreateKey groups={data.groups} look={look.data} onCreated={reload} />
            <section className="card" style={{ padding: '8px 8px 4px' }}>
              <div className="hd" style={{ padding: '12px 12px 0' }}>
                <h2>All keys</h2>
                <input className="inp" style={{ width: 260, minHeight: 40 }} type="search" placeholder="Search by person, key or group" aria-label="Search keys" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              {rows.length === 0 ? (
                <div className="empty">{data.keys.length ? 'No key matches.' : 'No keys yet. Create one above.'}</div>
              ) : (
                <div className="scroll">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Key</th>
                        <th>Person or bot</th>
                        <th>Group</th>
                        <th>Exceptions</th>
                        <th>Last used</th>
                        <th>Requests today</th>
                        <th>Status</th>
                        <th><span className="visually-hidden">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((k) => {
                        const expired = !!k.expiresAt && k.expiresAt < Date.now();
                        return (
                          <tr key={k.id}>
                            <td>
                              <div style={{ fontWeight: 600 }}>{k.name}</div>
                              <div className="mono muted">{k.prefix}…</div>
                            </td>
                            <td>{k.owner}</td>
                            <td><span className="pill info" title={k.groupPath}>{k.groupName}</span></td>
                            <td className="muted">{excText(k.exceptions, look.data!) || 'None'}</td>
                            <td className="muted">{ago(k.lastUsedAt)}</td>
                            <td className="mono">{fmt(k.requestsToday)}</td>
                            <td>
                              <span className={`pill ${k.revoked || expired ? 'bad' : 'ok'}`}>{k.revoked ? 'Revoked' : expired ? 'Expired' : 'Active'}</span>
                            </td>
                            <td>
                              <span className="wrap" style={{ flexWrap: 'nowrap' }}>
                                <button type="button" className="btn sm" onClick={() => setEdit(k)}>Edit</button>
                                <button type="button" className="btn sm danger" onClick={() => run(async () => { await api(`keys/${k.id}`, { method: 'PATCH', body: { revoked: !k.revoked } }); reload(); }, k.revoked ? 'Key restored' : 'Key revoked')}>
                                  {k.revoked ? 'Restore' : 'Revoke'}
                                </button>
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
      {edit && data && look.data && <EditKey k={edit} groups={data.groups} look={look.data} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void reload(); }} />}
    </>
  );
}

function excText(e: GroupSettings, look: Lookups) {
  const parts: string[] = [];
  if (e.context) parts.push(`+ ${display('context', e.context.value, look)}`);
  if (e.models) parts.push(`+ ${display('models', e.models.value, look)}`);
  if (e.rate_limit) parts.push(`Rate ${e.rate_limit.value} per min`);
  if (e.piguard_threshold) parts.push(`PIGuard ${Number(e.piguard_threshold.value).toFixed(2)}`);
  return parts.join(', ');
}

/** Form state for a key's exceptions. */
function useExceptions(init: GroupSettings = {}) {
  const [ctx, setCtx] = useState<number[]>((init.context?.value as number[]) ?? []);
  const [models, setModels] = useState<string[]>((init.models?.value as string[]) ?? []);
  const [rate, setRate] = useState<string>(init.rate_limit ? String(init.rate_limit.value) : '');
  const value: GroupSettings = {};
  if (ctx.length) value.context = { mode: 'add', value: ctx };
  if (models.length) value.models = { mode: 'add', value: models };
  if (rate) value.rate_limit = { mode: 'override', value: Number(rate) };
  return { ctx, setCtx, models, setModels, rate, setRate, value };
}

function Exceptions({ ex, look }: { ex: ReturnType<typeof useExceptions>; look: Lookups }) {
  const [adding, setAdding] = useState<'ctx' | 'model' | 'rate' | null>(null);
  const [pick, setPick] = useState('');
  return (
    <div className="stack">
      {ex.ctx.map((id) => (
        <div className="exc" key={`c${id}`}>
          <span className="pill warn">Adds</span>
          <span style={{ flex: '1 1 auto' }}>Context file <span className="mono">{look.files.find((f) => f.id === id)?.name}</span></span>
          <button type="button" className="btn sm" onClick={() => ex.setCtx(ex.ctx.filter((x) => x !== id))}>Remove</button>
        </div>
      ))}
      {ex.models.map((m) => (
        <div className="exc" key={`m${m}`}>
          <span className="pill warn">Adds</span>
          <span style={{ flex: '1 1 auto' }}>Model <span className="mono">{m}</span></span>
          <button type="button" className="btn sm" onClick={() => ex.setModels(ex.models.filter((x) => x !== m))}>Remove</button>
        </div>
      ))}
      {ex.rate && adding !== 'rate' && (
        <div className="exc">
          <span className="pill warn">Overrides</span>
          <span style={{ flex: '1 1 auto' }}>Rate limit {ex.rate} per minute</span>
          <button type="button" className="btn sm" onClick={() => ex.setRate('')}>Remove</button>
        </div>
      )}
      {adding && (
        <div className="wrap">
          {adding === 'rate' ? (
            <input className="inp" style={{ width: 200, minHeight: 36 }} type="number" min={1} placeholder="Requests per minute" value={pick} onChange={(e) => setPick(e.target.value)} />
          ) : (
            <select className="inp" style={{ width: 260, minHeight: 36 }} value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Pick…</option>
              {adding === 'ctx' ? look.files.filter((f) => !ex.ctx.includes(f.id)).map((f) => <option key={f.id} value={f.id}>{f.name}</option>) : look.models.filter((m) => !ex.models.includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          <button type="button" className="btn sm" disabled={!pick} onClick={() => {
            if (adding === 'ctx') ex.setCtx([...ex.ctx, Number(pick)]);
            else if (adding === 'model') ex.setModels([...ex.models, pick]);
            else ex.setRate(pick);
            setAdding(null);
            setPick('');
          }}>Add</button>
          <button type="button" className="btn sm ghost" onClick={() => { setAdding(null); setPick(''); }}>Cancel</button>
        </div>
      )}
      <div className="wrap">
        <button type="button" className="btn sm dash" onClick={() => setAdding('ctx')}>+ Extra context file</button>
        <button type="button" className="btn sm dash" onClick={() => setAdding('model')}>+ Extra model</button>
        <button type="button" className="btn sm dash" onClick={() => setAdding('rate')}>+ Different rate limit</button>
      </div>
    </div>
  );
}

function Preview({ groupId, exceptions, look, groupName }: { groupId: number; exceptions: GroupSettings; look: Lookups; groupName: string }) {
  const [r, setR] = useState<Resolution | null>(null);
  const key = JSON.stringify(exceptions);
  useEffect(() => {
    api<Resolution>('keys/preview', { body: { groupId, exceptions: JSON.parse(key) } }).then(setR).catch(() => setR(null));
  }, [groupId, key]);
  const e = r?.effective;
  const has = Object.keys(exceptions).length > 0;
  return (
    <div className="gets-box" style={{ flex: '2 1 300px' }}>
      <div>
        <div className="lbl" style={{ margin: 0 }}>This key will get</div>
        <div className="small" style={{ color: '#3E3A66' }}>Everything from {groupName} and its parent groups{has ? ', plus its exceptions.' : '.'}</div>
      </div>
      {e && (
        <dl className="gets">
          <dt>Servers</dt><dd>{display('servers', e.servers, look)}</dd>
          <dt>Models</dt><dd className="mono">{display('models', e.models, look)}</dd>
          <dt>Context</dt><dd className="mono">{display('context', e.context, look)}</dd>
          <dt>First check</dt><dd>{e.piguard_enabled ? `PIGuard, flags at ${e.piguard_threshold.toFixed(2)}` : <b>Off for this group (bypassed)</b>}</dd>
          <dt>Second check</dt><dd>{e.oss_enabled ? `OSS check with ${e.oss_prompt_parts.length ? `${e.oss_prompt_parts.map((p) => p.from).join(' + ')} lines` : 'the default prompt'}` : <b>Off for this group (bypassed)</b>}</dd>
          <dt>Rate limit</dt><dd>{e.rate_limit} per minute</dd>
        </dl>
      )}
      <Link href={`/groups?id=${groupId}`} className="small">See where each rule comes from</Link>
    </div>
  );
}

function CreateKey({ groups, look, onCreated }: { groups: GroupV[]; look: Lookups; onCreated: () => void }) {
  const params = useSearchParams();
  const [owner, setOwner] = useState('');
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<number>(Number(params.get('group')) || groups[groups.length > 1 ? 1 : 0]?.id);
  const [expires, setExpires] = useState('');
  const ex = useExceptions();
  const [made, setMade] = useState<string | null>(null);
  const { run, busy } = useAction();
  const toast = useToast();
  const group = groups.find((g) => g.id === groupId) ?? groups[0];
  const base = typeof window === 'undefined' ? '' : `${window.location.origin}/v1`;

  return (
    <section className="card" id="create">
      <div className="hd">
        <h2>Create a key</h2>
        <span className="muted small">Shown once. GuardRail stores only a hash.</span>
      </div>
      <div className="row" style={{ gap: 24 }}>
        <div className="stack" style={{ flex: '3 1 420px', gap: 18, minWidth: 0 }}>
          <div className="wrap" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <span className="num">1</span>
            <div style={{ flex: '1 1 auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <label><span className="lbl">Who is it for</span><input className="inp" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="rafi" /></label>
              <label><span className="lbl">Key name</span><input className="inp" value={name} onChange={(e) => setName(e.target.value)} placeholder="rafi-laptop-cline" /></label>
            </div>
          </div>
          <div className="wrap" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <span className="num">2</span>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <span className="lbl">Group</span>
              <GroupCascade groups={groups} value={group?.id ?? groupId} onChange={setGroupId} />
            </div>
          </div>
          <div className="wrap" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'nowrap' }}>
            <span className="num">3</span>
            <div className="stack" style={{ flex: '1 1 auto' }}>
              <span className="lbl" style={{ margin: 0 }}>Exceptions for this key only (optional)</span>
              <Exceptions ex={ex} look={look} />
              <label style={{ maxWidth: 260 }}>
                <span className="lbl">Expiry date (optional)</span>
                <input className="inp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
              </label>
            </div>
          </div>
          <div className="wrap" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn pri" disabled={busy || !owner.trim() || !name.trim()} onClick={() => run(async () => {
              const r = await api<{ secret: string }>('keys', { body: { owner, name, groupId, exceptions: ex.value, expiresAt: expires ? new Date(expires + 'T23:59:59').getTime() : null } });
              setMade(r.secret);
              setName('');
              onCreated();
            }, 'Key created')}>
              Create key
            </button>
          </div>
          {made && (
            <div className="stack" style={{ background: 'var(--frame)', borderRadius: 12, padding: 14, gap: 10 }}>
              <div className="wrap" style={{ gap: 10 }}>
                <code className="mono secret">{made}</code>
                <button type="button" className="btn" onClick={async () => {
                  const ok = await copy(made);
                  toast(ok ? 'Copied' : 'Copy failed, select the key and copy it', !ok);
                }}>
                  <Icon name="copy" />
                  Copy
                </button>
              </div>
              <div className="muted small">
                Copy it now, it will not be shown again. In Cline, pick OpenAI Compatible, set the base URL to <span className="mono" style={{ color: 'var(--ink)' }}>{base}</span> and paste this key.
              </div>
            </div>
          )}
        </div>
        {group && <Preview groupId={group.id} groupName={group.name} exceptions={ex.value} look={look} />}
      </div>
    </section>
  );
}

function EditKey({ k, groups, look, onClose, onDone }: { k: KeyV; groups: GroupV[]; look: Lookups; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(k.name);
  const [owner, setOwner] = useState(k.owner);
  const [groupId, setGroupId] = useState(k.groupId);
  const [expires, setExpires] = useState(k.expiresAt ? new Date(k.expiresAt).toISOString().slice(0, 10) : '');
  const ex = useExceptions(k.exceptions);
  const { run, busy } = useAction();
  return (
    <Modal title={`Edit ${k.name}`} onClose={onClose} wide>
      <div style={{ marginBottom: 16 }}>
        <span className="lbl">Group</span>
        <GroupCascade groups={groups} value={groupId} onChange={setGroupId} />
      </div>
      <div className="row" style={{ gap: 16 }}>
        <label style={{ flex: '1 1 200px' }}><span className="lbl">Key name</span><input className="inp" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label style={{ flex: '1 1 200px' }}><span className="lbl">Person or bot</span><input className="inp" value={owner} onChange={(e) => setOwner(e.target.value)} /></label>
        <label style={{ flex: '1 1 160px' }}><span className="lbl">Expiry date</span><input className="inp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></label>
      </div>
      <div className="row" style={{ gap: 16 }}>
        <div style={{ flex: '3 1 320px' }}>
          <span className="lbl">Exceptions for this key only</span>
          <Exceptions ex={ex} look={look} />
        </div>
        <Preview groupId={groupId} groupName={groups.find((g) => g.id === groupId)?.name ?? ''} exceptions={ex.value} look={look} />
      </div>
      <div className="between">
        <button type="button" className="btn danger" onClick={() => confirm(`Delete ${k.name} for good? Clients using it stop working.`) && run(async () => { await api(`keys/${k.id}`, { method: 'DELETE' }); onDone(); }, 'Key deleted')}>
          <Icon name="trash" size={14} />
          Delete key
        </button>
        <div className="wrap">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn pri" disabled={busy} onClick={() => run(async () => {
            await api(`keys/${k.id}`, { method: 'PATCH', body: { name, owner, groupId, exceptions: ex.value, expiresAt: expires ? new Date(expires + 'T23:59:59').getTime() : null } });
            onDone();
          }, 'Key saved')}>Save</button>
        </div>
      </div>
    </Modal>
  );
}
