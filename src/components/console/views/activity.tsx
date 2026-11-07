'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { diffMarks } from '@/components/prompt-view';
import type { LayerResult } from '@/lib/pipeline';
import type { ModelResponse, Step } from '@/lib/logs';
import { cacheOf } from '@/lib/adapters';
import { cacheLine } from '@/lib/cache-text';
import { ChatView, MSG_KINDS, type MsgKind, ResponseTail, countKinds } from '../chat';
import { Ico } from '../icons';
import { Empty, Field, Loading, Note, Page, Pill, Section, Seg, Stat, clock, fmt, ms } from '../kit';
import { pathFor, useNav } from '../nav';
import { adminFetch, api, useStore, useUi } from '../store';
import type { LogEntry } from '../types';
import { DecisionRow } from './guard';
import { usePref } from '../prefs';
import { MdText } from '../md-text';

type Counts = { all: number; blocked: number; rejected: number; false_alarm: number; clean: number; error: number; mcp: number };

const FILTERS: [string, string, keyof Counts][] = [
  ['', 'All', 'all'],
  ['clean', 'Clean', 'clean'],
  ['false_alarm', 'False alarm', 'false_alarm'],
  ['error', 'Error', 'error'],
  ['blocked', 'Blocked', 'blocked'],
  // Refused before any check: no or invalid key, address not allowed, revoked, rate limit.
  ['rejected', 'Rejected', 'rejected'],
  // Doc reads by agents over MCP: no model, no guard layers.
  ['mcp', 'MCP', 'mcp'],
];

export const OUTCOME: Record<string, [string, 'ok' | 'warn' | 'bad']> = {
  answered: ['Answered', 'ok'],
  redacted: ['Redacted, answered', 'warn'],
  false_alarm: ['False alarm, answered', 'warn'],
  blocked: ['Blocked', 'bad'],
  rejected: ['Rejected', 'bad'],
  error: ['Error', 'bad'],
};

export const LABELS: Record<string, [string, 'ok' | 'bad' | 'info']> = {
  mistake: ['Marked safe (mistake)', 'ok'],
  missed_attack: ['Marked unsafe', 'bad'],
  confirmed_safe: ['Confirmed safe', 'ok'],
};

export function Outcome({ r }: { r: Pick<LogEntry, 'outcome' | 'status_code'> }) {
  const [label, tone] = OUTCOME[r.outcome] ?? [r.outcome, 'warn'];
  return <Pill tone={tone}>{r.outcome === 'rejected' || r.outcome === 'error' ? `${label} ${r.status_code ?? ''}` : label}</Pill>;
}

/** One pill for what the guard layers did. */
function GuardPill({ r }: { r: LogEntry }) {
  if (r.path === '/mcp') return <Pill tone={r.outcome === 'answered' ? 'info' : 'bad'}>MCP</Pill>;
  if (r.outcome === 'rejected') return <Pill>Not checked</Pill>;
  if (r.outcome === 'blocked') return <Pill tone="bad">Blocked</Pill>;
  if (r.outcome === 'false_alarm') return <Pill tone="warn">Flag cleared</Pill>;
  if (r.outcome === 'redacted') return <Pill tone="warn">Redacted</Pill>;
  if (r.c1_status === 'off' && (r.c2_status === 'off' || r.c2_status === 'skipped')) return <Pill>Bypassed</Pill>;
  return <Pill tone="ok">Clean</Pill>;
}

const leaf = (g: string | null) => (g ? g.split(/ [›/] /).pop() : '–');
const day = (ts: number) => new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

// ---------------------------------------------------------------- right sidebar: the list

export function ActivityList() {
  const nav = useNav();
  const params = useSearchParams();
  const [filter, setFilter] = usePref('activity.filter', '');
  // A link like "/activity?filter=blocked" picks the filter; it is then remembered like a click.
  const linked = params.get('filter');
  useEffect(() => {
    if (linked !== null) setFilter(linked);
  }, [linked, setFilter]);
  const [q, setQ] = usePref('activity.q', '');
  const [query, setQuery] = useState(q);
  const [rows, setRows] = useState<LogEntry[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = usePref('activity.live', true);
  const [test, setTest] = usePref('activity.test', false);
  const { data } = useStore();
  const root = data?.groups.find((g) => g.parentId === null);
  const scoped = !!nav.key || (!!nav.group && nav.group !== root?.id);
  const [hidden, setHidden] = useState<{ scope: number; test: number } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const load = useCallback(async () => {
    try {
      const r = await api<{ rows: LogEntry[]; counts: Counts }>(`logs?filter=${filter}&q=${encodeURIComponent(query)}&limit=300${nav.group ? `&group=${nav.group}` : ''}${nav.key ? `&key=${nav.key}` : ''}${test ? '&test=only' : ''}`);
      setRows(r.rows);
      setCounts(r.counts);
      setErr(null);
      // Nothing here: are matching requests hidden by the picked group/key, or by the Test switch?
      if (!r.rows.length && !query) {
        const [all, other] = await Promise.all([
          api<{ counts: Counts }>(`logs?filter=${filter}&limit=1${test ? '&test=only' : ''}`),
          api<{ counts: Counts }>(`logs?filter=${filter}&limit=1${nav.group ? `&group=${nav.group}` : ''}${nav.key ? `&key=${nav.key}` : ''}${test ? '' : '&test=only'}`),
        ]);
        const pick = (c: Counts) => c[(FILTERS.find(([v]) => v === filter)?.[2] ?? 'all') as keyof Counts] ?? 0;
        setHidden({ scope: scoped ? pick(all.counts) : 0, test: pick(other.counts) });
      } else setHidden(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [filter, query, nav.group, nav.key, test, scoped]);
  useEffect(() => {
    void load();
    if (!live) return;
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), 10000);
    return () => clearInterval(t);
  }, [load, live]);

  return (
    <div className="cx-alist">
      <div className="cx-alist-tools">
        <div className="cx-filters" role="tablist" aria-label="Outcome">
          {FILTERS.map(([v, l, c]) => (
            <button key={v} type="button" role="tab" aria-selected={filter === v} className={`cx-chip ${filter === v ? 'on' : ''}`} onClick={() => setFilter(v)}>
              {l} <span>{fmt(counts?.[c] ?? 0)}</span>
            </button>
          ))}
        </div>
        <div className="cx-form-row center nowrap">
          <input className="cx-input sm grow" type="search" placeholder="Search key, person, model, IP or ID" aria-label="Search activity" value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="button" className={`cx-btn sm ${live ? 'on' : ''}`} aria-pressed={live} title="Refresh every 10 seconds" onClick={() => setLive(!live)}>
            <span className={`cx-live ${live ? 'on' : ''}`} /> Live
          </button>
          <button type="button" className={`cx-btn sm ${test ? 'on' : ''}`} aria-pressed={test} title="Show only Studio and replay traffic" onClick={() => setTest(!test)}>
            Test
          </button>
        </div>
      </div>
      <div className="cx-alist-body">
        {!rows ? (
          <Loading error={err} />
        ) : rows.length === 0 ? (
          <div className="cx-details-empty">
            {q ? 'No request matches the search.' : `No ${filter ? (FILTERS.find(([v]) => v === filter)?.[1] ?? '').toLowerCase() + ' ' : ''}requests ${nav.key ? 'from this key' : scoped ? 'in this group' : ''} yet.`}
            {!!hidden?.scope && (
              <p>
                {hidden.scope} matching request{hidden.scope === 1 ? ' is' : 's are'} outside this view (other groups or keys, or sent with no valid key).{' '}
                <button type="button" className="cx-link" onClick={() => root && nav.setScope({ group: root.id })}>
                  Show all
                </button>
              </p>
            )}
            {!!hidden?.test && (
              <p>
                {hidden.test} {test ? 'real' : 'test (Studio or replay)'} request{hidden.test === 1 ? '' : 's'} here.{' '}
                <button type="button" className="cx-link" onClick={() => setTest(!test)}>
                  {test ? 'Show real traffic' : 'Show test traffic'}
                </button>
              </p>
            )}
          </div>
        ) : (
          <table className="cx-atable">
            <thead>
              <tr>
                <th className="c-key">Key</th>
                <th className="c-who">Who</th>
                <th className="c-group">Group</th>
                <th className="c-model">Model</th>
                <th className="c-ip">IP address</th>
                <th className="c-when">When</th>
                <th className="c-guard">Guard</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const who = r.owner ?? 'unknown';
                const group = leaf(r.group_name);
                const model = r.model ?? '–';
                return (
                  <tr key={r.id} className={nav.id === r.id ? 'sel' : ''} tabIndex={0} onClick={() => nav.go(pathFor('activity', r.id))} onKeyDown={(e) => e.key === 'Enter' && nav.go(pathFor('activity', r.id))}>
                    <td className="c-key">
                      <b className="cx-ell" title={r.key_name ?? 'no key'}>
                        {r.key_name ?? 'no key'}
                      </b>
                      <div className="cx-ell cx-muted small l-2" title={`${who} · ${r.group_name ?? '–'}`}>
                        <span className="s-who">{who}</span>
                        <span className="s-group">{group}</span>
                      </div>
                      <div className="cx-ell cx-muted small mono l-3" title={r.ip ? `${model} · ${r.ip}` : model}>
                        <span className="s-model">{model}</span>
                        {r.ip && <span className="s-ip">{r.ip}</span>}
                      </div>
                    </td>
                    <td className="c-who cx-ell" title={who}>
                      {who}
                    </td>
                    <td className="c-group cx-ell" title={r.group_name ?? '–'}>
                      {group}
                    </td>
                    <td className="c-model cx-ell mono" title={model}>
                      {model}
                      {r.outcome === 'error' && <span className="bad"> {r.status_code ?? 'error'}</span>}
                    </td>
                    <td className="c-ip cx-ell mono cx-muted">{r.ip ?? '–'}</td>
                    <td className="c-when mono cx-muted">
                      <div>{clock(r.ts)}</div>
                      <div className="small">{day(r.ts)}</div>
                    </td>
                    <td className="c-guard">
                      <GuardPill r={r} />
                      {r.feedback && LABELS[r.feedback] && <div className="small" title={LABELS[r.feedback][0]}>{r.feedback === 'missed_attack' ? '⚑ unsafe' : '✓ safe'}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- /activity: summary and export

export function ActivityHome() {
  const { data } = useStore();
  const nav = useNav();
  const g = data?.groups.find((x) => x.id === nav.group);
  const scoped = g && g.parentId !== null ? g : null;
  const scopeKey = data?.keys.find((k) => k.id === nav.key) ?? null;
  const kq = scopeKey ? `&key=${scopeKey.id}` : '';
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [labels, setLabels] = useState<'all' | 'mistake' | 'missed_attack' | 'both'>('all');
  const [format, setFormat] = useState<'jsonl' | 'json'>('jsonl');
  const [busy, setBusy] = useState(false);
  const ui = useUi();
  const [counts, setCounts] = useState<Counts | null>(null);
  useEffect(() => {
    api<{ counts: Counts }>(`logs?limit=1${scoped ? `&group=${scoped.id}` : ''}${kq}`).then((r) => setCounts(r.counts), () => setCounts(null));
  }, [scoped, kq]);
  const download = async () => {
    setBusy(true);
    try {
      const lab = labels === 'all' ? '' : labels === 'both' ? 'mistake,missed_attack' : labels;
      const res = await adminFetch(`/api/admin/logs-export?from=${from}&to=${to}&format=${format}${lab ? `&labels=${lab}` : ''}${scoped ? `&group=${scoped.id}` : ''}${kq}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Export failed (${res.status})`);
      const n = res.headers.get('x-row-count');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `guardrail-activity.${format}`;
      a.click();
      ui.toast(`Exported ${n} request${n === '1' ? '' : 's'}`);
    } catch (e) {
      ui.toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      icon="activity"
      title={scopeKey ? `Activity · ${scopeKey.name}` : scoped ? `Activity · ${scoped.name}` : 'Activity'}
      sub={`Pick a request in the list on the right to open its session. ${scopeKey ? `Showing the key ${scopeKey.name} only.` : scoped ? `Showing ${scoped.path} and its sub-groups.` : 'Pick a group or key on the left to narrow the list.'}`}
    >
      <div className="cx-stats wide">
        <Stat label="All requests" value={fmt(counts?.all)} />
        <Stat label="Clean" value={fmt(counts?.clean)} tone="ok" />
        <Stat label="False alarms" value={fmt(counts?.false_alarm)} tone="warn" />
        <Stat label="Blocked" value={fmt(counts?.blocked)} tone="bad" />
        <Stat label="Errors" value={fmt(counts?.error)} tone="bad" />
      </div>
      <Section title="Export sessions" hint="Every request in the range with its full chat, what was sent to the model, each guard layer's verdict and your labels. Pick the labelled ones to build fine-tuning data.">
        <div className="cx-form-row">
          <Field label="From">
            <input className="cx-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input className="cx-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Only">
            <select className="cx-input" value={labels} onChange={(e) => setLabels(e.target.value as typeof labels)}>
              <option value="all">Every request</option>
              <option value="mistake">Blocked by mistake (marked safe)</option>
              <option value="missed_attack">Marked unsafe</option>
              <option value="both">Both labels</option>
            </select>
          </Field>
          <Field label="Format">
            <Seg value={format} onChange={setFormat} label="Format" options={[['jsonl', 'JSONL'], ['json', 'JSON']]} />
          </Field>
          <button type="button" className="cx-btn pri tall" disabled={busy || !from || !to} onClick={() => void download()}>
            <Ico n="download" size={14} /> {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </Section>
    </Page>
  );
}

// ---------------------------------------------------------------- /activity/:id

const TITLES: Record<string, string> = {
  answered: 'Clean request',
  redacted: 'Answered after redaction',
  false_alarm: 'False alarm, cleared by a later layer',
  blocked: 'Blocked before the model',
  rejected: 'Rejected before the checks',
  error: 'Failed at the backend',
};
const EXPIRED = 'This prompt was deleted. Prompt files are kept for 20 days by default (GUARDRAIL_PROMPT_RETENTION_DAYS).';

interface Replay {
  original: { id: string; outcome: string; reason: string | null; decisions: LayerResult[] | null; response?: ModelResponse | null };
  replay: { status: number; ms: number; text: string; error: string | null; log: LogEntry | null };
}

export function LogDetail({ id }: { id: string }) {
  const ui = useUi();
  const nav = useNav();
  const [d, setD] = useState<LogEntry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = usePref<'summary' | 'session' | 'sent'>('activity.tab', 'session');
  // Which message types the chat shows; empty means all. Remembered in this browser.
  const [show, setShow] = usePref<MsgKind[]>('activity.msgs', []);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replaying, setReplaying] = useState(false);
  const load = useCallback(() => api<LogEntry>(`logs/${encodeURIComponent(id)}`).then(setD, (e) => setErr((e as Error).message)), [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const marks = useMemo(() => (d?.forwarded ? diffMarks(d.forwarded, d.prompt) : []), [d]);
  if (!d) return <Loading error={err} />;
  const passed = d.outcome === 'answered' || d.outcome === 'redacted' || d.outcome === 'false_alarm';
  const verdict = d.outcome === 'blocked' ? (['mistake', 'Mark safe (mistake)'] as const) : passed ? (['missed_attack', 'Mark unsafe'] as const) : null;
  const label = async (v: string | null) => {
    await ui.run(() => api(`logs/${d.id}`, { method: 'PATCH', body: { feedback: v } }), v ? `Labelled: ${LABELS[v]?.[0].toLowerCase()}` : 'Label removed', { reload: false });
    void load();
  };
  const exportOne = () => {
    const blob = new Blob([JSON.stringify({ summary: { ...d, prompt: undefined, forwarded: undefined }, chat: d.prompt, sent_to_model: d.forwarded }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${d.id}.json`;
    a.click();
  };
  const runReplay = async () => {
    setReplaying(true);
    await ui.run(async () => setReplay(await api<Replay>(`logs/${d.id}/replay`, { body: {} })), undefined, { reload: false });
    setReplaying(false);
  };
  return (
    <Page
      icon="activity"
      wide
      scrollKey={tab}
      pinned={
      <div className="cx-subtabs" role="tablist" aria-label="Request view">
          {(
            [
              ['session', `Session${d.prompt ? ` (${d.prompt.length})` : ''}`],
              ['summary', 'Summary'],
              ['sent', 'Sent to the model'],
            ] as const
          ).map(([t, l]) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {l}
            </button>
          ))}
          {tab !== 'summary' && (
            <>
              <KindFilter show={show} setShow={setShow} counts={countKinds(tab === 'session' ? d.prompt : d.forwarded, tab === 'session' ? d.response : null)} />
            </>
          )}
        </div>
      }
      title={TITLES[d.outcome] ?? 'Request'}
      sub={
        <>
          {new Date(d.ts).toLocaleString('en-GB')} · <span className="mono">{d.id}</span> · {d.key_name ?? 'no key'} ({d.owner ?? 'unknown'}) · {d.group_name ?? '–'} · <span className="mono" title="Client IP address">{d.ip ?? 'IP not recorded'}</span>
        </>
      }
      actions={
        <>
          <Outcome r={d} />
          {d.test && <Pill tone="info">Test traffic</Pill>}
          {d.feedback && LABELS[d.feedback] ? (
            <button type="button" className="cx-btn on" title="Remove the label" onClick={() => void label(null)}>
              {LABELS[d.feedback][0]} ✕
            </button>
          ) : (
            verdict && (
              <button type="button" className="cx-btn" onClick={() => void label(verdict[0])}>
                {verdict[1]}
              </button>
            )
          )}
          <button type="button" className="cx-btn" disabled={replaying || !d.prompt?.length} title="Send the same request through today's context and guard layers" onClick={() => void runReplay()}>
            <Ico n="refresh" size={14} /> {replaying ? 'Replaying…' : 'Replay'}
          </button>
          <button type="button" className="cx-btn" disabled={!d.prompt?.length} title="Open this request as a new Studio scenario" onClick={() => nav.go(`/studio?from=${encodeURIComponent(d.id)}`)}>
            <Ico n="studio" size={14} /> Open in Studio
          </button>
          <button type="button" className="cx-btn" onClick={exportOne}>
            <Ico n="download" size={14} /> JSON
          </button>
        </>
      }
    >
      {replay && <ReplayView r={replay} onClose={() => setReplay(null)} />}
      {tab === 'session' && (
        <ChatView
          messages={d.prompt}
          show={show}
          empty={d.prompt_expired ? EXPIRED : 'No prompt was recorded. The request was rejected before its body was read.'}
          tail={d.response || d.outcome === 'blocked' ? (d.response ? <ResponseTail r={d.response} show={show} outcome={d.outcome} ms={d.stages?.upstream ? `${ms(d.stages.upstream)} upstream` : undefined} /> : <BlockedTail d={d} />) : <ResponseTail r={null} show={show} outcome={d.outcome} />}
        />
      )}
      {tab === 'summary' && <Summary d={d} />}
      {tab === 'sent' && (
        <>
          {d.forwarded && marks.some(Boolean) && <Note>Highlighted messages were added or changed by Opsara (context or redaction).</Note>}
          <ChatView messages={d.forwarded} marks={marks} show={show} empty={d.prompt_expired ? EXPIRED : 'Nothing was sent to the model: the request was rejected or blocked first.'} />
        </>
      )}
    </Page>
  );
}

function BlockedTail({ d }: { d: LogEntry }) {
  return (
    <div className="cx-turn blocked">
      <div className="cx-turn-head">
        <span>blocked reply</span>
      </div>
      <MdText text={d.reason ?? 'Blocked.'} />
    </div>
  );
}

function Summary({ d }: { d: LogEntry }) {
  const rows: [string, React.ReactNode][] = [
    ['When', new Date(d.ts).toLocaleString('en-GB')],
    ['Key · person', `${d.key_name ?? 'no key'} · ${d.owner ?? 'unknown'}`],
    ['Group', d.group_name ?? '–'],
    ['IP address', d.ip ? <span key="ip" className="mono">{d.ip}</span> : <span key="ip" className="cx-muted">Not recorded</span>],
    ['Model · server', <span key="m" className="mono">{`${d.model ?? '–'}${d.server ? ` · ${d.server}` : ''}`}</span>],
    ...((): [string, React.ReactNode][] => {
      const r = (d.decisions ?? []).find((x) => x.action === 'route' && x.route);
      if (!r?.route) return [];
      const text = r.route.model ? `${r.name} answered "${r.route.label ?? 'no answer'}" → ${r.route.model}` : `${r.name} answered "${r.route.label ?? 'no answer'}" → kept the client's model`;
      return [['Routed', <span key="rt" className="mono">{text}</span>]];
    })(),
    ['Schema', d.schema ?? '–'],
    ['Outcome', <Outcome key="o" r={d} />],
    ['Reason', d.reason ?? '–'],
    ...(d.injected?.identity ? ([['Caller identity', <span key="ci" className="mono">{d.injected.identity}</span>]] as [string, React.ReactNode][]) : []),
    ['Total time', ms(d.latency_ms)],
    ['Tokens out', fmt(d.tokens_out)],
    ...((): [string, React.ReactNode][] => {
      const c = cacheOf(d.response);
      return c ? [['Prompt cache (model call)', `${cacheLine(c)}${d.response?.provider ? ` · provider ${d.response.provider}` : ''}`]] : [];
    })(),
    ...(d.decisions ?? [])
      .filter((x) => x.decision?.cache)
      .map((x): [string, React.ReactNode] => [`Prompt cache (${x.name})`, `${cacheLine(x.decision!.cache!)}${x.decision!.suffix ? ' · suffix check' : ''}`]),
  ];
  const stages = Object.entries(d.stages ?? {});
  return (
    <div className="cx-cols">
      <Section title="What happened">
        <table className="cx-table kv">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <div className="cx-form">
        <Section title="Guard layers">{d.decisions?.length ? d.decisions.map((r) => <DecisionRow key={`${r.id}-${r.stage ?? 'input'}-${r.attempt ?? 0}`} r={r} />) : <Note>This request was logged before guard layers, or never reached them. The timeline below shows what ran.</Note>}</Section>
        <Section title="Context added">
          {d.injected ? (
            <div className="cx-list">
              {d.injected.policy && (
                <div className="cx-list-row">
                  <b className="grow">Gateway policy prompt</b>
                </div>
              )}
              {d.injected.files.map((f) => (
                <div key={f.name} className="cx-list-row">
                  <span className="mono grow">{f.name}</span>
                  <span className="cx-muted tnum">{fmt(f.tokens)} tokens</span>
                </div>
              ))}
              <div className="cx-list-row cx-muted small">
                {fmt(d.injected.tokens)} tokens added {d.injected.placement === 'end' ? 'before the last user message' : 'at the top of the system prompt'}
              </div>
            </div>
          ) : (
            <Note>Nothing was added: no context files and no policy prompt for this group.</Note>
          )}
        </Section>
        {stages.length > 0 && (
          <Section title="Stage timings">
            {stages.map(([k, v]) => (
              <div key={k} className="cx-bar-row">
                <span>{k.replace(/^layer_/, 'layer ')}</span>
                <span className="cx-bar">
                  <i style={{ width: `${Math.min(100, (v / Math.max(...stages.map((s) => s[1]), 1)) * 100)}%` }} />
                </span>
                <span className="mono cx-muted">{ms(v)}</span>
              </div>
            ))}
          </Section>
        )}
      </div>
      <Section title="Timeline">
        <Timeline steps={d.steps} />
      </Section>
    </div>
  );
}

function ReplayView({ r, onClose }: { r: Replay; onClose: () => void }) {
  const rl = r.replay.log;
  return (
    <Section title="Replay through today's setup" hint="Same prompt, key and model, sent again with the current context and guard layers. The original log is unchanged; the replay is logged as test traffic." actions={<button type="button" className="cx-btn sm" onClick={onClose}>Close</button>}>
      <div className="cx-cols">
        <div className="cx-replay">
          <h3>Then</h3>
          <Outcome r={{ outcome: r.original.outcome as LogEntry['outcome'], status_code: null }} />
          {r.original.reason && <p className="cx-muted small">{r.original.reason}</p>}
          {(r.original.decisions ?? []).map((x) => (
            <DecisionRow key={`${x.id}-${x.stage ?? "input"}-${x.attempt ?? 0}`} r={x} />
          ))}
          {r.original.response ? (
            <div className="cx-turn">
              <div className="cx-turn-head">
                <span>{r.original.response.blocked ? 'blocked reply' : r.original.response.error ? 'error' : 'reply'}</span>
                {r.original.response.message.tool_calls?.length ? <span className="cx-muted small">{r.original.response.message.tool_calls.length} tool call(s)</span> : null}
              </div>
              <MdText text={r.original.response.error ?? (typeof r.original.response.message.content === 'string' && r.original.response.message.content ? r.original.response.message.content : r.original.response.message.tool_calls?.length ? r.original.response.message.tool_calls.map((c) => `${c.function?.name}(${c.function?.arguments ?? ''})`).join('\n') : '(empty reply)')} />
            </div>
          ) : (
            <p className="cx-muted small">The original reply was not recorded (an older request).</p>
          )}
        </div>
        <div className="cx-replay">
          <h3>Now</h3>
          {rl ? <Outcome r={rl} /> : <Pill tone={r.replay.status < 400 ? 'ok' : 'bad'}>HTTP {r.replay.status}</Pill>}
          {rl?.reason && <p className="cx-muted small">{rl.reason}</p>}
          {(rl?.decisions ?? []).map((x) => (
            <DecisionRow key={`${x.id}-${x.stage ?? "input"}-${x.attempt ?? 0}`} r={x} />
          ))}
          <div className="cx-turn">
            <div className="cx-turn-head">
              <span>{r.replay.error ? `error ${r.replay.status}` : 'reply'}</span>
              <span className="cx-muted small">{ms(r.replay.ms)}</span>
            </div>
            <MdText text={r.replay.error ?? (r.replay.text || '(empty reply)')} />
          </div>
        </div>
      </div>
    </Section>
  );
}

export function Timeline({ steps }: { steps: Step[] }) {
  if (!steps.length) return <Note>No steps were recorded.</Note>;
  return (
    <ol className="cx-timeline">
      {steps.map((s, i) => (
        <li key={i} className={s.tone}>
          <span className="cx-tl-dot">{i + 1}</span>
          <div className="cx-tl-body">
            <div className="cx-tl-head">
              <b>{s.head}</b>
              <span className="mono cx-muted">{ms(s.ms)}</span>
            </div>
            <div className="cx-muted">{s.text}</div>
            {s.quote && <blockquote className="cx-quote">{s.quote}</blockquote>}
            {s.why && <pre className="cx-pre">{s.why}</pre>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function NoActivity() {
  return <Empty icon="activity" title="Nothing selected" />;
}

/** Show only some message types in a chat: chips with counts; none picked (or "All") shows everything. */
function KindFilter({ show, setShow, counts }: { show: MsgKind[]; setShow: (v: MsgKind[]) => void; counts: Record<MsgKind, number> }) {
  return (
    <div className="cx-kindfilter" role="group" aria-label="Message types">
      <button type="button" className={`cx-chip ${show.length === 0 ? 'on' : ''}`} aria-pressed={show.length === 0} onClick={() => setShow([])}>
        All
      </button>
      {MSG_KINDS.filter(([k]) => counts[k] > 0 || show.includes(k)).map(([k, l]) => {
        const on = show.includes(k);
        return (
          <button key={k} type="button" className={`cx-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => setShow(on ? show.filter((x) => x !== k) : [...show, k])}>
            {l} <span>{counts[k]}</span>
          </button>
        );
      })}
    </div>
  );
}
