'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { display } from '@/components/format-setting';
import { Icon, Loading, Modal, PageHead, Switch, api, groupColor, initials, useAction, useApi } from '@/components/ui';
import type { Group, GroupSettings, Resolution, SettingKey, SettingValue, StoredSetting } from '@/lib/groups';
import type { ApiKey } from '@/lib/keys';
import type { AppSettings } from '@/lib/settings';

interface GroupV extends Group {
  path: string;
  depth: number;
  keyCount: number;
  childCount: number;
}
interface List {
  groups: GroupV[];
  files: { id: number; name: string; tokens: number }[];
  servers: { id: number; name: string }[];
  models: string[];
  modelServers: Record<string, string[]>;
  settings: AppSettings;
}
interface One {
  group: Group;
  chain: { id: number; name: string }[];
  resolution: Resolution;
  keys: ApiKey[];
}

type Tab = 'eff' | 'access' | 'ctx' | 'guard' | 'keys';
const TABS: [Tab, string][] = [
  ['eff', 'Effective rules'],
  ['access', 'Servers and models'],
  ['ctx', 'Context'],
  ['guard', 'Guard'],
  ['keys', 'Keys'],
];

export default function GroupsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Groups />
    </Suspense>
  );
}

function Groups() {
  const params = useSearchParams();
  const list = useApi<List>('groups');
  const [sel, setSel] = useState<number | null>(params.get('id') ? Number(params.get('id')) : null);
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'eff');
  const [creating, setCreating] = useState<number | null | undefined>(undefined);
  const selId = sel ?? list.data?.groups[0]?.id ?? null;
  const one = useApi<One>(selId ? `groups/${selId}` : null, [selId]);
  const reloadAll = () => {
    void list.reload();
    void one.reload();
  };

  return (
    <>
      <PageHead step="Step 2 of 5" title="Groups" sub="Put keys in groups. A sub-group gets everything from its parent, then adds or changes what it needs.">
        <button type="button" className="btn" onClick={() => setCreating(selId)}>
          + New group
        </button>
        <Link href="/keys" className="btn blk">
          Next: API keys
        </Link>
      </PageHead>
      <div className="content">
        {!list.data ? (
          <Loading error={list.error} />
        ) : (
          <div className="row">
            <aside className="card" style={{ flex: '1 1 240px', maxWidth: '100%', padding: 14 }} aria-label="Group tree">
              <div className="lbl" style={{ padding: '4px 8px 8px' }}>
                Group tree
              </div>
              <div className="stack" style={{ gap: 2 }}>
                {list.data.groups.map((g) => {
                  const [bg, fg] = groupColor(g.id, g.parentId === null);
                  return (
                    <button key={g.id} type="button" className={g.id === selId ? 'tnode on' : 'tnode'} style={{ paddingLeft: 8 + g.depth * 22 }} onClick={() => setSel(g.id)}>
                      {g.depth > 0 && <span className="elbow" aria-hidden="true" />}
                      <span className="gdot" style={{ background: bg, color: fg }}>
                        {initials(g.name)}
                      </span>
                      <span style={{ flex: '1 1 auto' }}>{g.name}</span>
                      <span className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
                        {g.keyCount} key{g.keyCount === 1 ? '' : 's'}
                      </span>
                    </button>
                  );
                })}
              </div>
              {selId && (
                <button type="button" className="btn sm dash" style={{ margin: '12px 8px 4px' }} onClick={() => setCreating(selId)}>
                  + Add sub-group under {list.data.groups.find((g) => g.id === selId)?.name}
                </button>
              )}
            </aside>
            {!one.data || one.data.group.id !== selId ? (
              <div style={{ flex: '999 1 600px' }}>
                <Loading error={one.error} />
              </div>
            ) : (
              <Detail list={list.data} one={one.data} tab={tab} setTab={setTab} reload={reloadAll} onSelect={setSel} />
            )}
          </div>
        )}
      </div>
      {creating !== undefined && list.data && (
        <CreateGroup
          groups={list.data.groups}
          parentId={creating}
          onClose={() => setCreating(undefined)}
          onDone={(id) => {
            setCreating(undefined);
            setSel(id);
            setTab('eff');
            reloadAll();
          }}
        />
      )}
    </>
  );
}

function Detail({ list, one, tab, setTab, reload, onSelect }: { list: List; one: One; tab: Tab; setTab: (t: Tab) => void; reload: () => void; onSelect: (id: number) => void }) {
  const g = one.group;
  const [editing, setEditing] = useState(false);
  const { run } = useAction();
  const isRoot = g.parentId === null;
  const save = (key: SettingKey, setting: StoredSetting | null, ok = 'Saved') =>
    run(async () => {
      await api(`groups/${g.id}/settings`, { method: 'PUT', body: { key, setting } });
      reload();
    }, ok);

  return (
    <section className="card stack" style={{ flex: '999 1 600px', gap: 18 }}>
      <div className="between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 20 }}>{g.name}</h2>
          <div className="muted small" style={{ marginTop: 2 }}>
            {g.description || (isRoot ? 'The root group. Every key inherits these rules.' : 'No description.')}
          </div>
        </div>
        <div className="wrap">
          <button type="button" className="btn sm" onClick={() => setEditing(true)}>
            {isRoot ? 'Rename' : 'Rename or move'}
          </button>
          {!isRoot && (
            <button
              type="button"
              className="btn sm danger"
              onClick={() =>
                confirm(`Delete the group ${g.name}?`) &&
                run(async () => {
                  await api(`groups/${g.id}`, { method: 'DELETE' });
                  onSelect(g.parentId!);
                  reload();
                }, 'Group deleted')
              }
            >
              Delete
            </button>
          )}
        </div>
      </div>

      <div>
        <div className="lbl">Inherits from</div>
        <div className="chain">
          {one.chain.map((c, i) => {
            const [bg, fg] = groupColor(c.id, i === 0);
            return (
              <span key={c.id} className="wrap" style={{ gap: 8 }}>
                <button type="button" className={c.id === g.id ? 'c me' : 'c'} onClick={() => onSelect(c.id)}>
                  <span className="gdot" style={{ width: 22, height: 22, fontSize: 10, background: bg, color: fg }}>
                    {initials(c.name)}
                  </span>
                  {c.name}
                </button>
                {i < one.chain.length - 1 && <Icon name="chevron" color="#A0A5B4" stroke={2.2} />}
              </span>
            );
          })}
        </div>
      </div>

      <div className="tabs line" role="tablist" aria-label="Group settings">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'eff' && <Effective list={list} one={one} />}
      {tab === 'access' && <Access list={list} one={one} save={save} />}
      {tab === 'ctx' && <Context list={list} one={one} save={save} />}
      {tab === 'guard' && <Guard one={one} save={save} />}
      {tab === 'keys' && <Keys one={one} />}
      {editing && <EditGroup g={g} groups={list.groups} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload(); }} />}
    </section>
  );
}

// ---- Effective rules matrix ----

function effValue(key: SettingKey, r: Resolution): SettingValue {
  const e = r.effective;
  if (key === 'oss_prompt') return e.oss_prompt_parts.length ? `Default + ${e.oss_prompt_parts.map((p) => p.from).join(' + ')}` : 'Default security policy';
  if (key === 'blocked_reply') return e.blocked_reply.split('\n')[0];
  return e[key] as SettingValue;
}

function Effective({ list, one }: { list: List; one: One }) {
  const cols = `150px repeat(${one.chain.length}, minmax(120px, 1fr)) minmax(150px, 1.2fr)`;
  const CLS = { inherited: 'cell c-inh', set: 'cell c-set', add: 'cell c-add', override: 'cell c-ovr' };
  const TAG = { inherited: 'inherited', set: 'set', add: 'adds', override: 'overrides' };
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="legend">
        <span><i className="sq" style={{ background: '#fff', border: '1px solid #C9CDD8' }} />Set</span>
        <span><i className="sq" style={{ background: '#E3F7EA', border: '1px solid #BFE8CD' }} />Adds to parent</span>
        <span><i className="sq" style={{ background: '#FEF1DC', border: '1px solid #F1D7A6' }} />Overrides parent</span>
        <span><i className="sq" style={{ background: '#F7F8FA', border: '1px dashed #C9CDD8' }} />Inherited</span>
        <span><i className="sq" style={{ background: '#F3F1FF', border: '1px solid #C9C2F5' }} />What keys in {one.group.name} get</span>
      </div>
      <div className="mx">
        <div style={{ minWidth: 680 }}>
          <div className="mxr" style={{ gridTemplateColumns: cols }}>
            <span className="mxh">Setting</span>
            {one.chain.map((c) => (
              <span className="mxh" key={c.id}>{c.name}</span>
            ))}
            <span className="mxh" style={{ color: 'var(--accent)' }}>Result</span>
          </div>
          {one.resolution.matrix.map((row) => (
            <div className="mxr" style={{ gridTemplateColumns: cols }} key={row.key}>
              <span style={{ fontSize: 13, fontWeight: 600, padding: 8, display: 'flex', alignItems: 'center' }}>{row.label}</span>
              {row.cells.map((c, i) => (
                <div className={CLS[c.state]} key={i}>
                  <span className="tag">{TAG[c.state]}</span>
                  <span>{c.state === 'inherited' ? (i === 0 ? 'Default' : 'Same as parent') : (c.state === 'add' ? '+ ' : '') + display(row.key, c.value, list)}</span>
                </div>
              ))}
              <div className="cell c-res">
                <span style={{ fontWeight: 600 }}>{display(row.key, effValue(row.key, one.resolution), list)}</span>
                <span className="muted" style={{ fontSize: 11.5 }}>From {one.resolution.sources[row.key].join(' + ')}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---- mode picker shared by list settings ----

function ModeBar({ isRoot, stored, onMode, what }: { isRoot: boolean; stored: StoredSetting | undefined; onMode: (m: 'inherit' | 'add' | 'override') => void; what: string }) {
  if (isRoot) return null;
  const cur = !stored ? 'inherit' : stored.mode === 'add' ? 'add' : 'override';
  return (
    <div className="modebar">
      <span className="muted">{what}:</span>
      <div className="seg">
        <button type="button" className={cur === 'inherit' ? 'on' : ''} onClick={() => onMode('inherit')}>Same as parent</button>
        <button type="button" className={cur === 'add' ? 'on' : ''} onClick={() => onMode('add')}>Add to parent</button>
        <button type="button" className={cur === 'override' ? 'on' : ''} onClick={() => onMode('override')}>Replace</button>
      </div>
    </div>
  );
}

type Save = (key: SettingKey, s: StoredSetting | null, ok?: string) => Promise<unknown>;

function Access({ list, one, save }: { list: List; one: One; save: Save }) {
  const g = one.group;
  const isRoot = g.parentId === null;
  const own = g.settings as GroupSettings;
  const eff = one.resolution.effective;
  const ownModels = (own.models?.value as string[] | undefined) ?? [];
  const mode = isRoot ? 'set' : own.models ? own.models.mode : 'inherit';
  const all = eff.models.includes('*');
  // Where each allowed model came from.
  const src = (m: string) => {
    let from = 'Not allowed';
    one.chain.forEach((c, i) => {
      const cell = one.resolution.matrix.find((r) => r.key === 'models')!.cells[i];
      if (cell.state === 'inherited') return;
      const v = (cell.value as string[]) ?? [];
      if (cell.state !== 'add') from = v.includes(m) || v.includes('*') ? (c.id === g.id ? 'Set here' : `From ${c.name}`) : 'Not allowed';
      else if (v.includes(m) || v.includes('*')) from = c.id === g.id ? 'Added here' : `From ${c.name}`;
    });
    return from;
  };
  const toggle = (m: string, on: boolean) => {
    const base = mode === 'inherit' ? 'add' : mode;
    const next = on ? [...ownModels, m] : ownModels.filter((x) => x !== m);
    void save('models', { mode: base === 'set' ? 'set' : base, value: next }, on ? `${m} allowed` : `${m} removed`);
  };
  const serverMode = own.servers ? 'only' : 'same';
  const ownServers = (own.servers?.value as number[] | null | undefined) ?? null;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div>
        <div className="muted small" style={{ marginBottom: 8 }}>
          Pick which models keys in {g.name} can call. Ticks from a parent group show where they came from.
        </div>
        <ModeBar
          isRoot={isRoot}
          stored={own.models}
          what="Models"
          onMode={(m) => void save('models', m === 'inherit' ? null : { mode: m, value: m === 'override' ? eff.models : ownModels })}
        />
        <div className="arow" style={{ borderTop: 0, fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
          <span>Model</span>
          <span>Servers</span>
          <span>Comes from</span>
          <span>Allowed</span>
        </div>
        <div className="arow">
          <span style={{ fontWeight: 600 }}>All models, including ones added later</span>
          <span className="muted">Every server</span>
          <span>{all ? <span className="pill">{src('*')}</span> : <span className="pill">Off</span>}</span>
          <Switch on={all} label="Allow all models" disabled={mode === 'add' && all && !ownModels.includes('*')} onChange={(v) => toggle('*', v)} />
        </div>
        {list.models.length === 0 && <div className="arow muted">No models yet. Add a server in step 1.</div>}
        {list.models.map((m) => {
          const on = all || eff.models.includes(m);
          const s = src(m);
          const inherited = on && !s.endsWith('here');
          return (
            <div className="arow" key={m}>
              <span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{m}</span>
              <span className="muted">{list.modelServers[m]?.join(', ')}</span>
              <span><span className={`pill ${s.endsWith('here') ? 'info' : ''}`}>{all && !eff.models.includes(m) ? 'Via All models' : s}</span></span>
              <Switch on={on} label={`Allow ${m}`} disabled={(inherited && mode !== 'override' && mode !== 'set') || (all && !eff.models.includes(m))} onChange={(v) => toggle(m, v)} />
            </div>
          );
        })}
      </div>

      <div className="stack">
        <span className="lbl" style={{ margin: 0 }}>Servers</span>
        <div className="seg">
          <button type="button" className={serverMode === 'same' ? 'on' : ''} onClick={() => void save('servers', isRoot ? { mode: 'set', value: null } : null)}>
            {isRoot ? 'All servers' : 'Same as parent'}
          </button>
          <button type="button" className={serverMode === 'only' && ownServers !== null ? 'on' : ''} onClick={() => void save('servers', { mode: 'override', value: list.servers.map((s) => s.id) })}>
            Only these servers
          </button>
        </div>
        {ownServers !== null && serverMode === 'only' && (
          <div className="wrap">
            {list.servers.map((s) => (
              <label key={s.id} className="chk" style={{ marginRight: 12 }}>
                <input type="checkbox" checked={ownServers.includes(s.id)} onChange={(e) => void save('servers', { mode: 'override', value: e.target.checked ? [...ownServers, s.id] : ownServers.filter((x) => x !== s.id) })} />
                {s.name}
              </label>
            ))}
          </div>
        )}
        <div className="muted small">Keys in {g.name} reach: {display('servers', eff.servers, list)}.</div>
      </div>
    </div>
  );
}

function Context({ list, one, save }: { list: List; one: One; save: Save }) {
  const g = one.group;
  const isRoot = g.parentId === null;
  const own = g.settings.context;
  const ownIds = (own?.value as number[] | undefined) ?? [];
  const eff = one.resolution.effective.context;
  const [add, setAdd] = useState('');
  const mode = isRoot ? 'set' : own ? own.mode : 'inherit';
  const srcOf = (id: number) => {
    if (ownIds.includes(id)) return 'Added here';
    for (let i = one.chain.length - 2; i >= 0; i--) {
      const cell = one.resolution.matrix.find((r) => r.key === 'context')!.cells[i];
      if (cell.state !== 'inherited' && ((cell.value as number[]) ?? []).includes(id)) return `From ${one.chain[i].name}`;
    }
    return 'Inherited';
  };
  const setOwn = (ids: number[]) => save('context', { mode: mode === 'inherit' ? 'add' : (mode as 'add' | 'override' | 'set'), value: ids });
  const move = (id: number, d: -1 | 1) => {
    const i = ownIds.indexOf(id);
    const j = i + d;
    if (i < 0 || j < 0 || j >= ownIds.length) return;
    const n = [...ownIds];
    [n[i], n[j]] = [n[j], n[i]];
    void setOwn(n);
  };
  const tokens = eff.reduce((a, id) => a + (list.files.find((f) => f.id === id)?.tokens ?? 0), 0);
  return (
    <div className="stack">
      <div className="muted small">
        These files are added to the top of every request from {g.name}, in this order. Inherited files come first. {tokens.toLocaleString()} tokens in total.
      </div>
      <ModeBar isRoot={isRoot} stored={own} what="Context files" onMode={(m) => void save('context', m === 'inherit' ? null : { mode: m, value: m === 'override' ? eff : ownIds })} />
      {eff.length === 0 && <div className="muted small">No context files yet.</div>}
      {eff.map((id) => {
        const f = list.files.find((x) => x.id === id);
        const mine = ownIds.includes(id);
        return (
          <div key={id} className="layer">
            <span className="mono" style={{ fontWeight: 500, fontSize: 12.5, flex: '1 1 auto' }}>{f?.name ?? 'Deleted file'}</span>
            <span className="mono muted">{f?.tokens.toLocaleString()} tok</span>
            <span className={`pill ${mine ? 'info' : ''}`}>{srcOf(id)}</span>
            {mine && (
              <span className="wrap" style={{ gap: 2 }}>
                <button type="button" className="btn sm ghost" aria-label="Move up" onClick={() => move(id, -1)}><Icon name="up" size={14} /></button>
                <button type="button" className="btn sm ghost" aria-label="Move down" onClick={() => move(id, 1)}><Icon name="down" size={14} /></button>
                <button type="button" className="btn sm ghost" aria-label={`Remove ${f?.name}`} onClick={() => void setOwn(ownIds.filter((x) => x !== id))}><Icon name="x" size={14} /></button>
              </span>
            )}
          </div>
        );
      })}
      <div className="wrap">
        <select className="inp" style={{ width: 260, minHeight: 36 }} value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Context file to add">
          <option value="">Pick a file to add…</option>
          {list.files.filter((f) => !eff.includes(f.id)).map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </select>
        <button type="button" className="btn sm" disabled={!add} onClick={() => { void setOwn([...ownIds, Number(add)]); setAdd(''); }}>
          Add
        </button>
        <Link className="btn sm dash" href="/context">
          + New context file
        </Link>
      </div>
    </div>
  );
}

function Guard({ one, save }: { one: One; save: Save }) {
  const g = one.group;
  const isRoot = g.parentId === null;
  const eff = one.resolution.effective;
  const src = one.resolution.sources;
  const ownT = g.settings.piguard_threshold;
  const [t, setT] = useState(Number(ownT?.value ?? eff.piguard_threshold));
  const ownPrompt = g.settings.oss_prompt;
  const [prompt, setPrompt] = useState(String(ownPrompt?.value ?? ''));
  const [reply, setReply] = useState(String(g.settings.blocked_reply?.value ?? ''));
  const [rate, setRate] = useState(String(g.settings.rate_limit?.value ?? ''));
  useEffect(() => {
    setT(Number(g.settings.piguard_threshold?.value ?? one.resolution.effective.piguard_threshold));
    setPrompt(String(g.settings.oss_prompt?.value ?? ''));
    setReply(String(g.settings.blocked_reply?.value ?? ''));
    setRate(String(g.settings.rate_limit?.value ?? ''));
  }, [g, one.resolution.effective.piguard_threshold]);
  const inherited = useMemo(() => {
    const parts = eff.oss_prompt_parts.filter((p) => p.from !== g.name);
    const base = ownPrompt?.mode === 'override' ? '' : '# Default (Guard checks page)\n…';
    return [base, ...parts.map((p) => `# from ${p.from}\n${p.text}`)].filter(Boolean).join('\n\n');
  }, [eff, g.name, ownPrompt]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid-kpi" style={{ gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="cell c-res" style={{ padding: 14 }}>
          <span className="lbl" style={{ margin: 0 }}>PIGuard flags at score</span>
          <span style={{ fontSize: 20, fontWeight: 700 }}>{eff.piguard_threshold.toFixed(2)}</span>
          <span className="muted" style={{ fontSize: 12 }}>From {src.piguard_threshold.join(' + ')}</span>
        </div>
        <div className="cell c-res" style={{ padding: 14 }}>
          <span className="lbl" style={{ margin: 0 }}>When PIGuard flags</span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Ask the OSS check</span>
          <span className="muted" style={{ fontSize: 12 }}>Set on Guard checks</span>
        </div>
        <div className="cell c-res" style={{ padding: 14 }}>
          <span className="lbl" style={{ margin: 0 }}>Rate limit</span>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{eff.rate_limit} per minute per key</span>
          <span className="muted" style={{ fontSize: 12 }}>From {src.rate_limit.join(' + ')}</span>
        </div>
      </div>

      <div className="stack">
        <div className="between">
          <span className="lbl" style={{ margin: 0 }}>PIGuard score for {g.name}: <span className="mono" style={{ color: 'var(--ink)' }}>{t.toFixed(2)}</span></span>
          {ownT && <button type="button" className="btn sm" onClick={() => void save('piguard_threshold', null, 'Back to the inherited score')}>Use inherited</button>}
        </div>
        <input type="range" min={0.3} max={0.95} step={0.05} value={t} onChange={(e) => setT(Number(e.target.value))} onMouseUp={() => void save('piguard_threshold', { mode: 'override', value: t }, `${g.name} flags at ${t.toFixed(2)}`)} onKeyUp={() => void save('piguard_threshold', { mode: 'override', value: t })} aria-label="PIGuard threshold" />
        <div className="muted small">Lower catches more but sends more requests to check 2.</div>
      </div>

      {!isRoot && (
        <div>
          <span className="lbl">OSS check system prompt, inherited part</span>
          <div className="inhbox">{inherited || 'Nothing inherited.'}</div>
        </div>
      )}
      <label>
        <span className="lbl">{isRoot ? 'Lines this group adds to the default OSS prompt' : `Added by ${g.name} (appended to the inherited prompt)`}</span>
        <textarea className="own" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="For example: Files in tests/fixtures contain fake secrets on purpose." />
      </label>
      <div className="wrap">
        <button type="button" className="btn sm blk" onClick={() => void save('oss_prompt', prompt.trim() ? { mode: 'add', value: prompt } : null, 'Prompt saved')}>Save prompt lines</button>
        <Link href="/guard" className="small">See how the two checks work together</Link>
      </div>

      <div className="row" style={{ gap: 16 }}>
        <label style={{ flex: '2 1 320px' }}>
          <span className="lbl">Blocked reply for {g.name} (empty = inherited: {display('blocked_reply', eff.blocked_reply, { files: [], servers: [] })})</span>
          <textarea value={reply} onChange={(e) => setReply(e.target.value)} style={{ minHeight: 90 }} placeholder="Use {reason} and {request_id}" />
          <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => void save('blocked_reply', reply.trim() ? { mode: 'override', value: reply } : null, 'Blocked reply saved')}>Save reply</button>
        </label>
        <label style={{ flex: '1 1 200px' }}>
          <span className="lbl">Rate limit per key, per minute (empty = inherited)</span>
          <input className="inp" type="number" min={1} value={rate} onChange={(e) => setRate(e.target.value)} />
          <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => void save('rate_limit', rate ? { mode: 'override', value: Number(rate) } : null, 'Rate limit saved')}>Save limit</button>
        </label>
      </div>
    </div>
  );
}

function Keys({ one }: { one: One }) {
  return (
    <div className="stack">
      {one.keys.length === 0 && <div className="muted small">No keys in this group yet.</div>}
      {one.keys.map((k) => (
        <div key={k.id} className="wrap" style={{ gap: 12, border: '1px solid var(--line)', borderRadius: 12, padding: '12px 14px', fontSize: 13 }}>
          <span style={{ fontWeight: 600, flex: '1 1 160px' }}>{k.name}</span>
          <span>{k.owner}</span>
          <span className="mono muted">{k.prefix}…</span>
          <span className={`pill ${Object.keys(k.exceptions).length ? 'info' : ''}`}>{Object.keys(k.exceptions).length ? `${Object.keys(k.exceptions).length} exception(s)` : 'Group rules only'}</span>
          {k.revoked && <span className="pill bad">Revoked</span>}
        </div>
      ))}
      <Link className="btn sm dash" style={{ alignSelf: 'flex-start' }} href={`/keys?group=${one.group.id}#create`}>
        + Create a key in {one.group.name}
      </Link>
    </div>
  );
}

function CreateGroup({ groups, parentId, onClose, onDone }: { groups: GroupV[]; parentId: number | null; onClose: () => void; onDone: (id: number) => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [parent, setParent] = useState<number>(parentId ?? groups[0].id);
  const { run, busy } = useAction();
  return (
    <Modal title="New group" onClose={onClose}>
      <label><span className="lbl">Name</span><input className="inp" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Frontend" /></label>
      <label>
        <span className="lbl">Sub-group of</span>
        <select className="inp" value={parent} onChange={(e) => setParent(Number(e.target.value))}>
          {groups.map((g) => <option key={g.id} value={g.id}>{'  '.repeat(g.depth)}{g.path}</option>)}
        </select>
      </label>
      <label><span className="lbl">Description (optional)</span><input className="inp" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      <div className="muted small">It starts with everything from its parent. Change only what differs.</div>
      <div className="wrap" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn pri" disabled={busy || !name.trim()} onClick={() => run(async () => { const g = await api<Group>('groups', { body: { name, parentId: parent, description: desc } }); onDone(g.id); }, 'Group created')}>Create group</button>
      </div>
    </Modal>
  );
}

function EditGroup({ g, groups, onClose, onDone }: { g: Group; groups: GroupV[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(g.name);
  const [desc, setDesc] = useState(g.description);
  const [parent, setParent] = useState(g.parentId);
  const { run, busy } = useAction();
  const options = groups.filter((x) => x.id !== g.id && !x.path.split(' › ').includes(g.name));
  return (
    <Modal title={`Edit ${g.name}`} onClose={onClose}>
      <label><span className="lbl">Name</span><input className="inp" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label><span className="lbl">Description</span><input className="inp" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      {g.parentId !== null && (
        <label>
          <span className="lbl">Move under</span>
          <select className="inp" value={parent ?? ''} onChange={(e) => setParent(Number(e.target.value))}>
            {options.map((x) => <option key={x.id} value={x.id}>{x.path}</option>)}
          </select>
        </label>
      )}
      <div className="wrap" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn pri" disabled={busy} onClick={() => run(async () => { await api(`groups/${g.id}`, { method: 'PATCH', body: { name, description: desc, ...(g.parentId !== null ? { parentId: parent } : {}) } }); onDone(); }, 'Group saved')}>Save</button>
      </div>
    </Modal>
  );
}
