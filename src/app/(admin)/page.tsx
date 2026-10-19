'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Icon, Loading, PageHead, clock, fmt, ms, useApi } from '@/components/ui';
import type { LogEntry } from '@/lib/logs';

interface Overview {
  counts: { all: number; blocked: number; false_alarm: number; clean: number; error: number };
  change: number | null;
  overheadP95: number | null;
  ossP50: number | null;
  buckets: { t: number; label: string; total: number; blocked: number }[];
  stages: { key: string; name: string; p50: number }[];
  recentBlocks: LogEntry[];
  servers: { id: number; name: string; url: string; role: string; status: string; latency_ms: number | null }[];
}

const RANGES = ['1h', '24h', '7d', '30d'];

export default function OverviewPage() {
  const [range, setRange] = useState('24h');
  const { data, error } = useApi<Overview>(`overview?range=${range}`, [range]);

  return (
    <>
      <PageHead title="Overview" sub="Traffic through the gateway, across all keys and servers">
        <div className="seg" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r} type="button" className={r === range ? 'on' : ''} onClick={() => setRange(r)}>
              {r}
            </button>
          ))}
        </div>
        <a className="btn" href={`/api/admin/logs?limit=5000`} download="guardrail-activity.json">
          <Icon name="download" />
          Export
        </a>
      </PageHead>
      {!data ? (
        <div className="content">
          <Loading error={error} />
        </div>
      ) : (
        <Body d={data} range={range} />
      )}
    </>
  );
}

function Body({ d, range }: { d: Overview; range: string }) {
  const peak = Math.max(1, ...d.buckets.map((b) => b.total));
  const peakB = Math.max(1, ...d.buckets.map((b) => b.blocked));
  const peakAt = d.buckets.find((b) => b.total === peak);
  const ticks = [0, Math.floor(d.buckets.length / 4), Math.floor(d.buckets.length / 2), Math.floor((3 * d.buckets.length) / 4), d.buckets.length - 1];
  const maxStage = Math.max(1, ...d.stages.map((s) => s.p50));
  const pctBlocked = d.counts.all ? ((d.counts.blocked / d.counts.all) * 100).toFixed(2) : '0';

  return (
    <div className="content">
      <div className="grid-kpi">
        <div className="card kpi">
          <div className="lbl">Requests</div>
          <div className="big">{fmt(d.counts.all)}</div>
          <div className="muted small">
            {d.change === null ? 'No earlier traffic to compare' : (
              <>
                <span style={{ color: d.change >= 0 ? 'var(--ok)' : 'var(--bad)' }}>{d.change >= 0 ? '+' : ''}{d.change}%</span> vs. previous {range}
              </>
            )}
          </div>
        </div>
        <div className="card kpi">
          <div className="lbl">Blocked</div>
          <div className="big">{fmt(d.counts.blocked)}</div>
          <div className="muted small">{pctBlocked}% of requests, including rejected keys</div>
        </div>
        <div className="card kpi">
          <div className="lbl">False alarms fixed</div>
          <div className="big">{fmt(d.counts.false_alarm)}</div>
          <div className="muted small">PIGuard flagged, OSS check let through</div>
        </div>
        <div className="card kpi">
          <div className="lbl">Gateway overhead p95</div>
          <div className="big">{ms(d.overheadP95)}</div>
          <div className="muted small">{d.ossP50 ? `Check 2 adds ${ms(d.ossP50)} when it runs` : 'Before the model starts answering'}</div>
        </div>
      </div>

      <div className="row">
        <section className="card" style={{ flex: '2 1 560px' }}>
          <div className="hd">
            <div>
              <h2>Requests</h2>
              <div className="muted small">{peakAt && peakAt.total ? `Peak ${fmt(peak)} at ${peakAt.label}` : 'No traffic yet'}</div>
            </div>
            <span className="pill info">All keys</span>
          </div>
          <div className="bars">
            {d.buckets.map((b) => (
              <div key={b.t} className="bar" title={`${b.label} · ${fmt(b.total)} requests`} style={{ height: `${Math.max(b.total ? 3 : 0, (b.total / peak) * 180)}px` }} />
            ))}
          </div>
          <div className="axis mono muted">
            {ticks.map((i, k) => (
              <span key={k}>{d.buckets[i]?.label}</span>
            ))}
          </div>
        </section>
        <section className="card" style={{ flex: '1 1 320px' }}>
          <div className="hd">
            <div>
              <h2>Blocked</h2>
              <div className="muted small">Guard, rules and rejected keys</div>
            </div>
          </div>
          <div className="bars red" style={{ gap: 3 }}>
            {d.buckets.map((b) => (
              <div key={b.t} className="bar" title={`${b.label} · ${fmt(b.blocked)} blocked`} style={{ height: `${Math.max(b.blocked ? 3 : 0, (b.blocked / peakB) * 180)}px` }} />
            ))}
          </div>
          <div className="axis mono muted">
            <span>{d.buckets[0]?.label}</span>
            <span>{d.buckets[d.buckets.length - 1]?.label}</span>
          </div>
        </section>
      </div>

      <div className="row">
        <section className="card" style={{ flex: '2 1 560px' }}>
          <div className="hd">
            <h2>Recent blocks</h2>
            <Link href="/activity?filter=blocked" className="small">
              Open activity
            </Link>
          </div>
          {d.recentBlocks.length === 0 ? (
            <div className="empty">Nothing blocked yet.</div>
          ) : (
            <div className="scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Who</th>
                    <th>Reason</th>
                    <th>Stage</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recentBlocks.map((r) => (
                    <tr key={r.id} className="click" onClick={() => (window.location.href = `/activity?id=${r.id}`)}>
                      <td className="mono">{clock(r.ts)}</td>
                      <td>
                        {r.owner ?? <span className="muted">no key · {r.ip ?? '?'}</span>} {r.key_name && <span className="mono muted">{r.key_name}</span>}
                      </td>
                      <td style={{ whiteSpace: 'normal', maxWidth: 360 }}>{r.reason}</td>
                      <td>{stageOf(r)}</td>
                      <td>
                        <span className="pill bad">{r.outcome === 'rejected' ? r.status_code : 'Blocked'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="col" style={{ flex: '1 1 320px' }}>
          <section className="card">
            <div className="hd">
              <h2>Stage latency, p50</h2>
            </div>
            {d.stages.length === 0 ? (
              <div className="muted small">Shows up after the first requests.</div>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                {d.stages.map((s) => (
                  <div key={s.key}>
                    <div className="between small" style={{ marginBottom: 4 }}>
                      <span>{s.name}</span>
                      <span className="mono muted">{ms(s.p50)}</span>
                    </div>
                    <div className="meter">
                      <i style={{ width: `${Math.max(2, (s.p50 / maxStage) * 100)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="card">
            <div className="hd">
              <h2>Servers</h2>
              <Link href="/servers" className="small">
                Manage
              </Link>
            </div>
            <div className="stack small" style={{ gap: 10 }}>
              {d.servers.length === 0 && (
                <div className="muted">
                  No servers yet. <Link href="/servers">Add a vLLM server</Link>.
                </div>
              )}
              {d.servers.map((s) => (
                <div key={s.id} className="between">
                  <span>
                    {s.name} <span className="mono muted">{s.url.replace(/^https?:\/\//, '')}</span>
                  </span>
                  <span className={`pill ${s.status === 'online' ? 'ok' : s.status === 'down' ? 'bad' : ''}`}>
                    {s.status === 'online' ? `Online · ${ms(s.latency_ms)}` : s.status === 'down' ? 'Down' : 'Not checked'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function stageOf(r: LogEntry) {
  if (r.outcome === 'rejected') return r.status_code === 401 ? 'Auth' : r.status_code === 422 ? 'Schema' : r.status_code === 429 ? 'Rate limit' : 'Access';
  if (r.c2_status === 'block' || r.c2_status === 'error') return `Check 2${r.c1_score !== null ? ` · ${r.c1_score.toFixed(2)}` : ''}`;
  if (r.c1_status === 'not_run') return 'Rule';
  return 'Guard';
}
