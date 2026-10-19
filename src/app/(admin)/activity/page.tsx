'use client';

import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon, Loading, PageHead, api, clock, fmt, ms, useAction, useApi } from '@/components/ui';
import type { LogEntry } from '@/lib/logs';

interface Logs {
  rows: LogEntry[];
  counts: { all: number; blocked: number; false_alarm: number; clean: number; error: number };
}

const FILTERS: [string, string, keyof Logs['counts']][] = [
  ['', 'All', 'all'],
  ['blocked', 'Blocked', 'blocked'],
  ['false_alarm', 'False alarms fixed', 'false_alarm'],
  ['clean', 'Clean', 'clean'],
  ['error', 'Errors', 'error'],
];

export default function ActivityPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Activity />
    </Suspense>
  );
}

function Activity() {
  const params = useSearchParams();
  const [filter, setFilter] = useState(params.get('filter') ?? '');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(params.get('id'));
  const { data, error, reload } = useApi<Logs>(`logs?filter=${filter}&q=${encodeURIComponent(query)}&limit=300`, [filter, query]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const t = setInterval(() => void reload(), 10000);
    return () => clearInterval(t);
  }, [reload]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const selected = useMemo(() => rows.find((r) => r.id === sel) ?? null, [rows, sel]);
  const [extra, setExtra] = useState<LogEntry | null>(null);
  useEffect(() => {
    if (sel && !rows.some((r) => r.id === sel)) api<LogEntry>(`logs/${sel}`).then(setExtra).catch(() => setExtra(null));
  }, [sel, rows]);
  const detail = selected ?? (extra?.id === sel ? extra : null) ?? rows[0] ?? null;

  const exportCsv = () => {
    const cols: (keyof LogEntry)[] = ['id', 'ts', 'owner', 'key_name', 'group_name', 'ip', 'model', 'server', 'schema', 'c1_score', 'c1_status', 'c2_status', 'c2_reason', 'outcome', 'status_code', 'reason', 'latency_ms', 'tokens_out', 'feedback'];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : k(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const k = (v: unknown) => (typeof v === 'number' && v > 1e12 ? new Date(v).toISOString() : String(v));
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'guardrail-activity.csv';
    a.click();
  };

  return (
    <>
      <PageHead
        title="Activity"
        sub="Every request, who sent it, and what each check decided."
        below={
          <div className="tabs" role="tablist" aria-label="Outcome" style={{ marginTop: 14 }}>
            {FILTERS.map(([id, label, c]) => (
              <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
                {label} ({fmt(data?.counts[c] ?? 0)})
              </button>
            ))}
          </div>
        }
      >
        <input className="inp" style={{ width: 240, minHeight: 40 }} type="search" placeholder="Search person, key, group or ID" aria-label="Search activity" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={exportCsv} disabled={!rows.length}>
          <Icon name="download" />
          Export
        </button>
      </PageHead>

      <div className="content">
        {!data ? (
          <Loading error={error} />
        ) : (
          <div className="row">
            <section className="card" style={{ flex: '999 1 560px', padding: '8px 8px 4px' }}>
              {rows.length === 0 ? (
                <div className="empty">
                  No requests yet. Point a client at <span className="mono">/v1</span> with a key from <Link href="/keys">API keys</Link>.
                </div>
              ) : (
                <div className="scroll">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Person · key</th>
                        <th>Group</th>
                        <th>Model</th>
                        <th>Check 1 · PIGuard</th>
                        <th>Check 2 · OSS</th>
                        <th>Outcome</th>
                        <th>
                          <span className="visually-hidden">Details</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className={detail?.id === r.id ? 'sel' : ''}>
                          <td className="mono">{clock(r.ts)}</td>
                          <td>
                            <div style={{ fontWeight: 600 }}>{r.owner ?? 'unknown'}</div>
                            <div className="mono muted">{r.key_name ?? 'no key'}</div>
                          </td>
                          <td>{r.group_name ? <span className="pill info">{r.group_name}</span> : <span className="muted">None</span>}</td>
                          <td className="mono">{r.model ?? 'n/a'}</td>
                          <td>
                            <C1 r={r} />
                          </td>
                          <td>
                            <C2 r={r} />
                          </td>
                          <td>
                            <Outcome r={r} />
                          </td>
                          <td>
                            <button type="button" className="btn sm" onClick={() => setSel(r.id)}>
                              Why?
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {detail && <Detail d={detail} onFeedback={reload} />}
          </div>
        )}
      </div>
    </>
  );
}

const OUT: Record<string, [string, string]> = {
  answered: ['Answered', 'ok'],
  redacted: ['Redacted, answered', 'warn'],
  false_alarm: ['False alarm, answered', 'warn'],
  blocked: ['Blocked reply sent', 'bad'],
  rejected: ['Rejected', 'bad'],
  error: ['Error', 'bad'],
};

function Outcome({ r }: { r: LogEntry }) {
  const [label, cls] = OUT[r.outcome] ?? [r.outcome, ''];
  return <span className={`pill ${cls}`}>{r.outcome === 'rejected' || r.outcome === 'error' ? `${label} ${r.status_code ?? ''}` : label}</span>;
}

function C1({ r }: { r: LogEntry }) {
  if (r.c1_status === 'flagged') return <span className="pill warn">{r.c1_score?.toFixed(2)} flagged</span>;
  if (r.c1_status === 'clean') return <span className="pill ok">{r.c1_score?.toFixed(2)} clean</span>;
  if (r.c1_status === 'skipped') return <span className="pill">Nothing new</span>;
  return <span className="pill">Not run</span>;
}

function C2({ r }: { r: LogEntry }) {
  if (r.c2_status === 'block') return <span className="pill bad">Block</span>;
  if (r.c2_status === 'error') return <span className="pill bad">Failed, blocked</span>;
  if (r.c2_status === 'allow') return <span className="pill ok">Allow</span>;
  if (r.c2_status === 'skipped') return <span className="pill">Skipped</span>;
  return <span className="pill">Not run</span>;
}

const TITLES: Record<string, string> = {
  answered: 'Clean request',
  redacted: 'Answered after redaction',
  false_alarm: 'False alarm, corrected by check 2',
  blocked: 'Blocked before the model',
  rejected: 'Rejected before the checks',
  error: 'Failed at the backend',
};

const FEEDBACK: Record<string, [string, string]> = {
  blocked: ['mistake', 'This was a mistake'],
  false_alarm: ['confirmed_safe', 'Confirm it was safe'],
  answered: ['missed_attack', 'Report a missed attack'],
  redacted: ['missed_attack', 'Report a missed attack'],
};

function Detail({ d, onFeedback }: { d: LogEntry; onFeedback: () => void }) {
  const { run } = useAction();
  const [label, cls] = OUT[d.outcome] ?? [d.outcome, ''];
  const fb = FEEDBACK[d.outcome];
  return (
    <aside className="card" style={{ flex: '1 1 360px', display: 'flex', flexDirection: 'column', gap: 14 }} aria-label="Request details">
      <div className="between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2>{TITLES[d.outcome] ?? 'Request'}</h2>
          <div className="muted small">
            {new Date(d.ts).toLocaleString('en-GB')} · <span className="mono">{d.id}</span>
          </div>
        </div>
        <span className={`pill ${cls}`}>{label}</span>
      </div>
      <div className="tl">
        {d.steps.map((s, i) => (
          <div className="ti" key={i}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span className={`dot ${s.tone}`}>{i + 1}</span>
              {i < d.steps.length - 1 && <span className="tline" />}
            </div>
            <div className="tbody">
              <div className="between" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <b>{s.head}</b>
                <span className="mono muted">{ms(s.ms)}</span>
              </div>
              <div className="muted">{s.text}</div>
              {s.quote && <div className="quote">{s.quote}</div>}
              {s.why && <div className="why">{s.why}</div>}
            </div>
          </div>
        ))}
      </div>
      <div className="muted small">
        {[d.schema && `Schema ${d.schema}`, d.server && `Server ${d.server}`, d.latency_ms !== null && `Total ${ms(d.latency_ms)}`, d.tokens_out && `${fmt(d.tokens_out)} tokens out`].filter(Boolean).join(' · ')}
      </div>
      <div className="wrap">
        {fb && (
          <button
            type="button"
            className={`btn sm${d.feedback === fb[0] ? ' blk' : ''}`}
            onClick={() => run(async () => {
              await api(`logs/${d.id}`, { method: 'PATCH', body: { feedback: d.feedback === fb[0] ? null : fb[0] } });
              onFeedback();
            }, d.feedback === fb[0] ? 'Feedback removed' : 'Thanks, noted for tuning')}
          >
            {d.feedback === fb[0] ? `Marked: ${fb[1].toLowerCase()}` : fb[1]}
          </button>
        )}
        <Link className="btn sm" href="/guard">
          Tune checks
        </Link>
      </div>
    </aside>
  );
}
