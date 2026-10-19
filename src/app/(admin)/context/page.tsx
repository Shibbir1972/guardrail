'use client';

import Link from 'next/link';
import { DragEvent, useEffect, useRef, useState } from 'react';
import { Icon, Loading, Modal, PageHead, Switch, ago, api, fmt, useAction, useApi, useToast } from '@/components/ui';
import type { ContextFile } from '@/lib/context';
import type { AppSettings } from '@/lib/settings';
import type { StoredSetting } from '@/lib/groups';

type FileV = ContextFile & { tokens: number; usedBy: string[]; reach: number };
interface GroupV {
  id: number;
  name: string;
  parentId: number | null;
  path: string;
  depth: number;
  context: number[];
  own: number[];
  mode: StoredSetting['mode'] | null;
  keys: string[];
}
interface Data {
  files: FileV[];
  groups: GroupV[];
  settings: AppSettings;
  cache: { name: string; rate: number | null }[];
}

const readFile = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result ?? ''));
  r.onerror = () => rej(r.error);
  r.readAsText(f);
});

export default function ContextPage() {
  const { data, error, reload } = useApi<Data>('context');
  const [gid, setGid] = useState<number | null>(null);
  const [doc, setDoc] = useState<number | null>(null);
  const [newFile, setNewFile] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const { run } = useAction();
  const toast = useToast();

  const g = data?.groups.find((x) => x.id === gid) ?? data?.groups[1] ?? data?.groups[0];
  const fileId = doc ?? g?.context[0] ?? data?.files[0]?.id ?? null;

  const uploadFiles = (files: FileList | File[]) =>
    run(async () => {
      let n = 0;
      for (const f of Array.from(files)) {
        if (!/\.(md|markdown|txt)$/i.test(f.name)) {
          toast(`${f.name} is not a .md file, skipped`, true);
          continue;
        }
        const body = await readFile(f);
        const existing = data?.files.find((x) => x.name === f.name);
        if (existing) await api(`context/${existing.id}`, { method: 'PATCH', body: { body } });
        else await api('context', { body: { name: f.name, body } });
        n++;
      }
      await reload();
      return n;
    }, 'Uploaded');

  return (
    <>
      <PageHead
        step="Step 4 of 5"
        title="Context files"
        sub="Markdown files about your project, added to the top of every request. Attach them to a group and every key in it gets them; sub-groups inherit them."
        below={
          data && (
            <div className="tabs" role="tablist" aria-label="Group" style={{ marginTop: 14 }}>
              {data.groups.map((x) => (
                <button key={x.id} type="button" role="tab" aria-selected={x.id === g?.id} className={x.id === g?.id ? 'on' : ''} onClick={() => setGid(x.id)}>
                  {x.name}
                </button>
              ))}
              <Link href="/groups" className="small" style={{ alignSelf: 'center', color: 'var(--muted)' }}>+ Another group</Link>
            </div>
          )
        }
      >
        <input ref={upload} type="file" accept=".md,.markdown,.txt,text/markdown" multiple hidden onChange={(e) => e.target.files && void uploadFiles(e.target.files)} />
        <button type="button" className="btn" onClick={() => upload.current?.click()}>
          <Icon name="upload" />
          Upload .md
        </button>
        <button type="button" className="btn pri" onClick={() => setNewFile(true)}>
          New file
        </button>
      </PageHead>
      {!data || !g ? (
        <div className="content"><Loading error={error} /></div>
      ) : (
        <Body data={data} g={g} fileId={fileId} setDoc={setDoc} reload={reload} onDrop={uploadFiles} />
      )}
      {newFile && (
        <NewFile
          onClose={() => setNewFile(false)}
          onDone={(f) => {
            setNewFile(false);
            setDoc(f.id);
            void reload();
          }}
        />
      )}
    </>
  );
}

function Body({ data, g, fileId, setDoc, reload, onDrop }: { data: Data; g: GroupV; fileId: number | null; setDoc: (id: number) => void; reload: () => Promise<void>; onDrop: (f: File[]) => void }) {
  const { run } = useAction();
  const [over, setOver] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const files = new Map(data.files.map((f) => [f.id, f]));
  const tokens = g.context.reduce((a, id) => a + (files.get(id)?.tokens ?? 0), 0);
  const version = g.context.reduce((a, id) => a + (files.get(id)?.version ?? 0), 0);
  const hit = data.cache.filter((c) => c.rate !== null);
  const avgHit = hit.length ? hit.reduce((a, c) => a + (c.rate ?? 0), 0) / hit.length : null;
  const isRoot = g.parentId === null;
  const inheritedIds = g.context.filter((id) => !g.own.includes(id));

  const saveCtx = (setting: StoredSetting | null, ok?: string) =>
    run(async () => {
      await api(`groups/${g.id}/settings`, { method: 'PUT', body: { key: 'context', setting } });
      await reload();
    }, ok);

  const toggle = (id: number, on: boolean) => {
    if (g.own.includes(id) && !on) {
      // Removing one of this group's own files.
      if (g.mode === 'override' || isRoot) return saveCtx({ mode: isRoot ? 'set' : 'override', value: g.context.filter((x) => x !== id) });
      return saveCtx(g.own.length > 1 ? { mode: 'add', value: g.own.filter((x) => x !== id) } : null);
    }
    // Turning off an inherited file means this group stops inheriting and lists its own set.
    if (!on) return saveCtx({ mode: 'override', value: g.context.filter((x) => x !== id) }, `${g.name} no longer gets ${files.get(id)?.name}`);
    return saveCtx({ mode: isRoot ? 'set' : g.mode === 'override' ? 'override' : 'add', value: [...g.own, id] });
  };

  const reorder = (from: number, to: number) => {
    if (from === to || !g.own.includes(from) || !g.own.includes(to)) return;
    const n = g.own.filter((x) => x !== from);
    n.splice(n.indexOf(to) + (g.own.indexOf(from) < g.own.indexOf(to) ? 1 : 0), 0, from);
    void saveCtx({ mode: isRoot ? 'set' : g.mode === 'override' ? 'override' : 'add', value: n });
  };

  const setPlacement = (p: 'top' | 'end') => run(async () => { await api('settings', { method: 'PATCH', body: { contextPlacement: p } }); await reload(); }, 'Placement saved');

  return (
    <div className="content">
      <div className="grid-kpi" style={{ gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <div className="card"><div className="lbl">Context for {g.name}</div><div style={{ fontSize: 26, fontWeight: 700 }}>{fmt(tokens)} tokens</div><div className="muted small">{g.context.length} files, sent with every request</div></div>
        <div className="card"><div className="lbl">Prefix cache hit rate</div><div style={{ fontSize: 26, fontWeight: 700, color: avgHit !== null ? 'var(--ok)' : undefined }}>{avgHit !== null ? `${Math.round(avgHit * 100)}%` : '–'}</div><div className="muted small">{avgHit !== null ? `From vLLM metrics on ${hit.map((c) => c.name).join(', ')}` : 'Shown once vLLM exposes /metrics'}</div></div>
        <div className="card"><div className="lbl">Keys that get it</div><div style={{ fontSize: 26, fontWeight: 700 }}>{g.keys.length}</div><div className="muted small">Directly in the {g.name} group</div></div>
        <div className="card"><div className="lbl">Version</div><div style={{ fontSize: 26, fontWeight: 700 }}>v{version}</div><div className="muted small">Editing a file starts a new version</div></div>
      </div>

      <div className="row">
        <aside className="card stack" style={{ flex: '1 1 240px', maxWidth: '100%', padding: 14, gap: 6 }} aria-label="Context files">
          <div className="lbl" style={{ padding: '4px 6px 0' }}>All context files</div>
          {data.files.length === 0 && <div className="muted small" style={{ padding: 6 }}>No files yet.</div>}
          {data.files.map((f) => (
            <button key={f.id} type="button" className={f.id === fileId ? 'doc on' : 'doc'} onClick={() => setDoc(f.id)}>
              <Icon name="file" color="#3A1FD1" />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{f.name}</span>
                <span className="muted" style={{ fontSize: 12 }}>{fmt(f.tokens)} tokens · {f.usedBy.length ? f.usedBy.join(', ') : 'not attached'}</span>
              </span>
            </button>
          ))}
          <div
            className={`drop${over ? ' over' : ''}`}
            style={{ marginTop: 8 }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e: DragEvent) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) onDrop(Array.from(e.dataTransfer.files)); }}
          >
            Drop .md files here
            <br />
            <span className="muted" style={{ fontSize: 12 }}>A file with the same name gets a new version</span>
          </div>
        </aside>

        <section className="card stack" style={{ flex: '999 1 460px', gap: 16 }}>
          <div className="hd" style={{ margin: 0 }}>
            <div>
              <h2>{g.name} group context</h2>
              <div className="muted small">Files marked Shared come from a parent group. Drag this group&apos;s own files to reorder.</div>
            </div>
          </div>
          <div className="stack">
            {g.context.length === 0 && <div className="muted small">Nothing yet. Add a file below.</div>}
            {[...inheritedIds, ...g.own.filter((id) => g.context.includes(id))].map((id) => {
              const f = files.get(id);
              const mine = g.own.includes(id);
              return (
                <div
                  key={id}
                  className={`layer${drag === id ? ' dragging' : ''}`}
                  draggable={mine}
                  onDragStart={() => setDrag(id)}
                  onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => mine && drag !== null && e.preventDefault()}
                  onDrop={() => drag !== null && reorder(drag, id)}
                >
                  <span className="grip"><Icon name="grip" stroke={3} /></span>
                  <span className="mono" style={{ fontWeight: 500, fontSize: 12.5, flex: '1 1 auto', minWidth: 0 }}>{f?.name ?? 'Deleted file'}</span>
                  <span className={`pill ${mine ? 'info' : ''}`}>{mine ? 'Group only' : 'Shared'}</span>
                  <span className="mono muted" style={{ width: 72, textAlign: 'right' }}>{fmt(f?.tokens)}</span>
                  <Switch on label={`Include ${f?.name}`} onChange={(v) => void toggle(id, v)} />
                </div>
              );
            })}
            {data.files.filter((f) => !g.context.includes(f.id)).map((f) => (
              <div key={f.id} className="layer" style={{ opacity: 0.7 }}>
                <span className="grip"><Icon name="grip" stroke={3} /></span>
                <span className="mono" style={{ fontWeight: 500, fontSize: 12.5, flex: '1 1 auto', minWidth: 0 }}>{f.name}</span>
                <span className="pill">Not included</span>
                <span className="mono muted" style={{ width: 72, textAlign: 'right' }}>{fmt(f.tokens)}</span>
                <Switch on={false} label={`Include ${f.name}`} onChange={(v) => void toggle(f.id, v)} />
              </div>
            ))}
          </div>
          {g.mode === 'override' && !isRoot && (
            <div className="modebar">
              <span className="muted">{g.name} lists its own files instead of inheriting.</span>
              <button type="button" className="btn sm" onClick={() => void saveCtx(null, 'Inheriting again')}>Inherit from parent again</button>
            </div>
          )}
          <div>
            <span className="lbl">Keys in the {g.name} group</span>
            <div className="wrap">
              {g.keys.map((k) => <span key={k} className="pill info mono" style={{ fontSize: 12 }}>{k}</span>)}
              <Link className="btn sm dash" href={`/groups?id=${g.id}&tab=ctx`}>Manage group</Link>
            </div>
          </div>
          <div>
            <span className="lbl">Where the context goes (all groups)</span>
            <div className="seg" role="group" aria-label="Placement">
              <button type="button" className={data.settings.contextPlacement === 'top' ? 'on' : ''} onClick={() => void setPlacement('top')}>Top of the prompt (cached)</button>
              <button type="button" className={data.settings.contextPlacement === 'end' ? 'on' : ''} onClick={() => void setPlacement('end')}>Before the last message (not cached)</button>
            </div>
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {data.settings.contextPlacement === 'top'
                ? 'Recommended. The context sits at the very start of the request, so it is the same prefix every time and stays in the cache.'
                : 'The model pays more attention to it, but it has to be recomputed on every request.'}
            </div>
          </div>
        </section>

        <section className="card stack" style={{ flex: '1 1 320px', gap: 12 }}>
          <div>
            <h2>What the model receives</h2>
            <div className="muted small">For a request from a {g.name} key</div>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="blk b-fixed"><span><b>1.</b> Gateway policy prompt{data.settings.policyPrompt ? '' : ' (empty)'}</span><span className="pill ok">Cached</span></div>
            <div className="blk b-fixed"><span><b>2.</b> {g.name} project context · {fmt(tokens)} tokens</span><span className={`pill ${data.settings.contextPlacement === 'top' ? 'ok' : ''}`}>{data.settings.contextPlacement === 'top' ? 'Cached' : 'Varies'}</span></div>
            <div className="blk b-var"><span><b>3.</b> The agent&apos;s own system prompt</span><span className="pill">Varies</span></div>
            <div className="blk b-var"><span><b>4.</b> Conversation and tool results</span><span className="pill">Varies</span></div>
          </div>
          <div className="note">Parts 1 and 2 never change between requests from the same group, so vLLM serves them from its prefix cache instead of recomputing them. Only parts 3 and 4 cost new prefill. Start vLLM with <span className="mono">--enable-prefix-caching</span>.</div>
          <PolicyPrompt value={data.settings.policyPrompt} onSaved={reload} />
        </section>
      </div>

      {fileId && files.get(fileId) && <Editor key={fileId} f={files.get(fileId)!} onSaved={reload} />}
    </div>
  );
}

function PolicyPrompt({ value, onSaved }: { value: string; onSaved: () => Promise<void> }) {
  const [v, setV] = useState(value);
  const { run, busy } = useAction();
  useEffect(() => setV(value), [value]);
  return (
    <label>
      <span className="lbl">Gateway policy prompt (part 1, every request)</span>
      <textarea style={{ minHeight: 90 }} value={v} onChange={(e) => setV(e.target.value)} placeholder="You are a coding assistant for [YOUR COMPANY]. Follow the project rules below." />
      <button type="button" className="btn sm blk" style={{ marginTop: 8 }} disabled={busy || v === value} onClick={() => run(async () => { await api('settings', { method: 'PATCH', body: { policyPrompt: v } }); await onSaved(); }, 'Policy prompt saved')}>Save</button>
    </label>
  );
}

function Editor({ f, onSaved }: { f: FileV; onSaved: () => Promise<void> }) {
  const [body, setBody] = useState(f.body);
  const [name, setName] = useState(f.name);
  const [hist, setHist] = useState(false);
  const replace = useRef<HTMLInputElement>(null);
  const { run, busy } = useAction();
  const dirty = body !== f.body || name !== f.name;
  const save = (b = body) => run(async () => { await api(`context/${f.id}`, { method: 'PATCH', body: { name, body: b } }); await onSaved(); }, 'File saved');
  return (
    <section className="card">
      <div className="hd">
        <div>
          <input className="inp mono" style={{ minHeight: 34, width: 280, fontWeight: 600 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" />
          <div className="muted small" style={{ marginTop: 4 }}>
            v{f.version} · {f.usedBy.length ? `attached to ${f.usedBy.join(', ')}` : 'not attached to a group'} · edited {ago(f.updated_at)}
          </div>
        </div>
        <div className="wrap">
          <button type="button" className="btn sm" onClick={() => setHist(true)}>History</button>
          <input ref={replace} type="file" accept=".md,.markdown,.txt" hidden onChange={async (e) => { const file = e.target.files?.[0]; if (file) { const t = await readFile(file); setBody(t); void save(t); } }} />
          <button type="button" className="btn sm" onClick={() => replace.current?.click()}>Replace with upload</button>
          <button type="button" className="btn sm danger" onClick={() => confirm(`Delete ${f.name}? Groups using it lose it.`) && run(async () => { await api(`context/${f.id}`, { method: 'DELETE' }); await onSaved(); }, 'File deleted')}>Delete</button>
          <button type="button" className="btn sm blk" disabled={busy || !dirty} onClick={() => void save()}>Save file</button>
        </div>
      </div>
      <textarea aria-label="File contents" style={{ minHeight: 260 }} value={body} onChange={(e) => setBody(e.target.value)} />
      {hist && <History f={f} onClose={() => setHist(false)} onRestore={(b) => { setBody(b); setHist(false); }} />}
    </section>
  );
}

function History({ f, onClose, onRestore }: { f: FileV; onClose: () => void; onRestore: (b: string) => void }) {
  const { data } = useApi<{ history: { version: number; body: string; created_at: number }[] }>(`context/${f.id}`);
  const [sel, setSel] = useState(0);
  const h = data?.history ?? [];
  return (
    <Modal title={`${f.name} history`} onClose={onClose} wide>
      <div className="row" style={{ gap: 16 }}>
        <div className="stack" style={{ flex: '1 1 160px', gap: 4 }}>
          {h.map((v, i) => (
            <button key={v.version} type="button" className={i === sel ? 'doc on' : 'doc'} onClick={() => setSel(i)}>
              <b>v{v.version}</b> <span className="muted small">{ago(v.created_at)}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: '4 1 400px' }}>
          <textarea readOnly value={h[sel]?.body ?? ''} style={{ minHeight: 300 }} aria-label="Version contents" />
          {h[sel] && sel > 0 && (
            <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => onRestore(h[sel].body)}>
              Load v{h[sel].version} into the editor
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function NewFile({ onClose, onDone }: { onClose: () => void; onDone: (f: ContextFile) => void }) {
  const [name, setName] = useState('');
  const [body, setBody] = useState('# Project context\n\n');
  const { run, busy } = useAction();
  return (
    <Modal title="New context file" onClose={onClose} wide>
      <label><span className="lbl">File name</span><input className="inp mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="frontend.md" autoFocus /></label>
      <textarea style={{ minHeight: 240 }} value={body} onChange={(e) => setBody(e.target.value)} aria-label="File contents" />
      <div className="wrap" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn pri" disabled={busy || !name.trim()} onClick={() => run(async () => onDone(await api<ContextFile>('context', { body: { name, body } })), 'File created')}>Create file</button>
      </div>
    </Modal>
  );
}
