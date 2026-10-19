'use client';

import { useState } from 'react';
import { Icon, Loading, Modal, PageHead, Switch, api, fmt, useAction, useApi } from '@/components/ui';
import type { Rule } from '@/lib/rules';

interface Data {
  rules: Rule[];
  groups: { id: number; name: string; path: string }[];
}

const TARGET = { any: 'any new text', user: 'the user message', tool: 'a tool result' };
const ACTION = { block: 'Block with a reply', redact: 'Redact the match', escalate: 'Send to check 2' };
const ACTION_CLS = { block: 'bad', redact: 'warn', escalate: 'info' };

export default function RulesPage() {
  const { data, error, reload } = useApi<Data>('rules');
  const [edit, setEdit] = useState<Partial<Rule> | null>(null);
  const { run } = useAction();
  return (
    <>
      <PageHead title="Custom rules" sub="Simple WHEN / THEN rules that run before the guard checks. Use them for things you always want caught, like secrets or banned commands.">
        <button type="button" className="btn pri" onClick={() => setEdit({ target: 'any', match_type: 'contains', action: 'block' })}>+ New rule</button>
      </PageHead>
      <div className="content">
        {!data ? (
          <Loading error={error} />
        ) : (
          <section className="card stack">
            {data.rules.length === 0 && <div className="empty">No rules yet. The guard checks still run on every request.</div>}
            {data.rules.map((r) => (
              <div key={r.id} className="rule" style={{ opacity: r.enabled ? 1 : 0.6 }}>
                <Switch on={!!r.enabled} label={`Rule ${r.name} on`} onChange={(v) => run(async () => { await api(`rules/${r.id}`, { method: 'PATCH', body: { enabled: v ? 1 : 0 } }); await reload(); })} />
                <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                  <b>{r.name}</b>
                  <div className="when">
                    <span className="kw">WHEN</span> {TARGET[r.target]} {r.match_type === 'regex' ? 'matches' : 'contains'} <span className="mono pill">{r.pattern}</span>
                    {r.group_id && <>for <span className="pill info">{data.groups.find((g) => g.id === r.group_id)?.name ?? '?'}</span></>}
                    <span className="kw">THEN</span> <span className={`pill ${ACTION_CLS[r.action]}`}>{ACTION[r.action]}</span>
                  </div>
                </div>
                <div className="wrap" style={{ flexWrap: 'nowrap' }}>
                  <span className="muted small">{fmt(r.hits)} hits</span>
                  <button type="button" className="btn sm" onClick={() => setEdit(r)}>Edit</button>
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
      {edit && data && <RuleModal r={edit} groups={data.groups} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void reload(); }} />}
    </>
  );
}

function RuleModal({ r, groups, onClose, onDone }: { r: Partial<Rule>; groups: Data['groups']; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<Partial<Rule>>(r);
  const [sample, setSample] = useState('');
  const { run, busy } = useAction();
  const set = (p: Partial<Rule>) => setV({ ...v, ...p });
  let test: string | null = null;
  if (sample && v.pattern) {
    try {
      const re = v.match_type === 'regex' ? new RegExp(v.pattern, 'i') : null;
      const hit = re ? re.exec(sample)?.[0] : sample.toLowerCase().includes(v.pattern.toLowerCase()) ? v.pattern : null;
      test = hit ? `Matches: "${hit}"` : 'No match';
    } catch {
      test = 'The pattern is not a valid regular expression';
    }
  }
  return (
    <Modal title={r.id ? 'Edit rule' : 'New rule'} onClose={onClose} wide>
      <label><span className="lbl">Name</span><input className="inp" value={v.name ?? ''} onChange={(e) => set({ name: e.target.value })} placeholder="Block private keys" autoFocus /></label>
      <div className="stack">
        <span className="kw">WHEN</span>
        <div className="row" style={{ gap: 10 }}>
          <select className="inp" style={{ flex: '1 1 160px' }} value={v.target} onChange={(e) => set({ target: e.target.value as Rule['target'] })}>
            {Object.entries(TARGET).map(([k, l]) => <option key={k} value={k}>{l[0].toUpperCase() + l.slice(1)}</option>)}
          </select>
          <select className="inp" style={{ flex: '1 1 140px' }} value={v.match_type} onChange={(e) => set({ match_type: e.target.value as Rule['match_type'] })}>
            <option value="contains">contains the text</option>
            <option value="regex">matches the regex</option>
          </select>
          <input className="inp mono" style={{ flex: '3 1 240px' }} value={v.pattern ?? ''} onChange={(e) => set({ pattern: e.target.value })} placeholder={v.match_type === 'regex' ? '-----BEGIN [A-Z ]*PRIVATE KEY-----' : 'rm -rf /'} />
        </div>
        <select className="inp" value={v.group_id ?? ''} onChange={(e) => set({ group_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">For every group</option>
          {groups.map((g) => <option key={g.id} value={g.id}>Only {g.path} and its sub-groups</option>)}
        </select>
      </div>
      <div className="stack">
        <span className="kw">THEN</span>
        <div className="seg">
          {(Object.keys(ACTION) as Rule['action'][]).map((a) => (
            <button key={a} type="button" className={v.action === a ? 'on' : ''} onClick={() => set({ action: a })}>{ACTION[a]}</button>
          ))}
        </div>
        {v.action === 'block' && <label><span className="lbl">Reason shown to the user (fills {'{reason}'} in the blocked reply)</span><input className="inp" value={v.message ?? ''} onChange={(e) => set({ message: e.target.value })} placeholder="Private keys may not be sent to the model." /></label>}
        {v.action === 'redact' && <div className="muted small">The matching text is replaced with [REDACTED] and the request goes on.</div>}
        {v.action === 'escalate' && <div className="muted small">The request goes to check 2 even if PIGuard scores it clean.</div>}
      </div>
      <label>
        <span className="lbl">Try it on sample text</span>
        <input className="inp" value={sample} onChange={(e) => setSample(e.target.value)} />
        {test && <span className="small muted">{test}</span>}
      </label>
      <div className="between">
        {r.id ? (
          <button type="button" className="btn danger" onClick={() => confirm('Delete this rule?') && run(async () => { await api(`rules/${r.id}`, { method: 'DELETE' }); onDone(); }, 'Rule deleted')}><Icon name="trash" size={14} />Delete</button>
        ) : <span />}
        <div className="wrap">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn pri" disabled={busy} onClick={() => run(async () => {
            if (r.id) await api(`rules/${r.id}`, { method: 'PATCH', body: v });
            else await api('rules', { body: v });
            onDone();
          }, 'Rule saved')}>Save rule</button>
        </div>
      </div>
    </Modal>
  );
}
