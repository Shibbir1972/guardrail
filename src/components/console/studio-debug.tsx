'use client';

import { type CacheUse, cacheOf } from '@/lib/adapters';
import { NOT_REPORTED, cacheLine } from '@/lib/cache-text';
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ScenarioSettings } from '@/lib/studio';
import type { Plan } from '@/lib/studio-plan';
import { Loading, Note, Pill, Seg, fmt, fmtTokens, ms } from './kit';
import { writePref } from './prefs';
import { adminFetch, api, useStore } from './store';
import type { LogEntry } from './types';
import { OUTCOME, Timeline } from './views/activity';
import { ACTION_LABEL, ACTION_TONE } from './views/guard';

// ---------------------------------------------------------------- shared state between the chat and the panel

interface DebugState {
  scenarioId: number | null;
  settings: ScenarioSettings | null;
  /** Logged request the panel shows; null shows the plan. */
  logId: string | null;
  /** Every turn of the chat, oldest first, so the panel can step through them. */
  turns: { logId: string; label: string }[];
  /** What the client received, for turns sent in this page load. */
  raw: Record<string, string>;
  /** Bumped after each send so the plan reloads. */
  rev: number;
  /** While a message is being sent: what has happened so far, live. */
  live: LiveState | null;
}

export interface LiveItem {
  key: string;
  mark: 'pass' | 'block' | 'flag' | 'skip' | 'error' | 'info' | 'run';
  title: string;
  answer: string;
  detail?: string;
}
export interface LiveState {
  items: LiveItem[];
  /** The answer's text so far, as it streams. */
  tokens: string;
  /** After-the-model checks hold the answer: the latest draft, not yet released to the client. */
  draft: { attempt: number; text: string } | null;
  status: string;
  started: number;
  cost: number;
}

type LiveEvent =
  | { type: 'step'; step: { tone: string; head: string; text: string; ms: number } }
  | { type: 'layer'; phase: 'start' | 'done'; id: string; name: string; n: number; stage: 'input' | 'output'; attempt?: number; result?: { action: string; decision?: { score?: number | null; latency_ms?: number; reason?: string; error?: string; cache?: { cached: number; prompt: number } | null; cost?: number | null } | null } }
  | { type: 'model'; attempt: number; model: string }
  | { type: 'draft'; attempt: number; text: string; toolCalls: number; cache: CacheUse | null; cost: number | null }
  | { type: 'token'; text: string };

const money = (n: number) => (n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toPrecision(2)}`);
const cacheText = (c?: CacheUse | null) => (c && c.prompt ? (c.cached === null ? `cache: ${NOT_REPORTED}` : `cache ${c.cached.toLocaleString()}/${c.prompt.toLocaleString()}`) : '');

/** Fold one live event into the progress shown while a message is being sent. */
export function applyLive(s: LiveState, e: LiveEvent): LiveState {
  const items = [...s.items];
  const put = (it: LiveItem) => {
    const i = items.findIndex((x) => x.key === it.key);
    if (i >= 0) items[i] = it;
    else items.push(it);
  };
  if (e.type === 'token') return { ...s, tokens: s.tokens + e.text, status: 'Model answering…' };
  if (e.type === 'step') {
    // Layer and model steps are shown by their own events; keep the others (key, rules, context, routing…).
    if (/^Check \d|^Answer #|^Sent to the model|answered$|streamed$/.test(e.step.head)) return s;
    put({ key: `step-${items.length}`, mark: e.step.tone === 'bad' ? 'block' : e.step.tone === 'warn' ? 'flag' : e.step.tone === 'ok' ? 'pass' : 'info', title: e.step.head, answer: '', detail: e.step.text });
    return { ...s, items };
  }
  if (e.type === 'layer') {
    const key = `layer-${e.stage}-${e.id}-${e.attempt ?? 0}`;
    const title = `${e.n}. ${e.name}${e.stage === 'output' ? ` · answer #${e.attempt ?? 1}` : ''}`;
    if (e.phase === 'start') {
      put({ key, mark: 'run', title, answer: 'checking…' });
      return { ...s, items, status: `${e.name}: checking…` };
    }
    const r = e.result;
    const d = r?.decision;
    const a = r?.action ?? 'done';
    const mark: LiveItem['mark'] = d?.error ? 'error' : a === 'block' ? 'block' : a === 'flag' || a === 'redact' ? 'flag' : a === 'pass' || a === 'cleared' || a === 'route' ? 'pass' : 'skip';
    const cost = d?.cost ?? 0;
    put({ key, mark, title, answer: [ACTION_LABEL[a] ?? a, d?.score != null ? d.score.toFixed(2) : '', d?.latency_ms != null ? ms(d.latency_ms) : '', cacheText(d?.cache), d?.cost ? money(d.cost) : ''].filter(Boolean).join(' · '), detail: d?.error ?? d?.reason });
    return { ...s, items, cost: s.cost + cost };
  }
  if (e.type === 'model') {
    put({ key: `model-${e.attempt}`, mark: 'run', title: `Model call${e.attempt > 1 ? ` · answer #${e.attempt}` : ''}`, answer: `${e.model}…` });
    return { ...s, items, tokens: e.attempt > 1 ? '' : s.tokens, status: e.attempt > 1 ? `Asking ${e.model} again (answer #${e.attempt})…` : `Calling ${e.model}…` };
  }
  // A full draft answer held for after-the-model checks.
  put({ key: `model-${e.attempt}`, mark: 'pass', title: `Model call${e.attempt > 1 ? ` · answer #${e.attempt}` : ''}`, answer: [`${e.text.length.toLocaleString()} chars${e.toolCalls ? ` · ${e.toolCalls} tool call(s)` : ''}`, cacheText(e.cache), e.cost ? money(e.cost) : ''].filter(Boolean).join(' · ') });
  return { ...s, items, draft: { attempt: e.attempt, text: e.text }, status: 'Checking the answer before releasing it…', cost: s.cost + (e.cost ?? 0) };
}

/** Send a Studio message through the live endpoint: events as they happen, then the final result. */
export async function sendLive<T>(body: unknown, onEvent: (e: LiveEvent) => void): Promise<T> {
  const res = await adminFetch('/api/admin/studio/live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `Request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let tail = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (tail + dec.decode(value, { stream: true })).split('\n');
    tail = lines.pop() ?? '';
    for (const l of lines) {
      if (!l.startsWith('data:')) continue;
      const e = JSON.parse(l.slice(5)) as LiveEvent | { type: 'result'; run: T } | { type: 'error'; message: string };
      if (e.type === 'result') return e.run;
      if (e.type === 'error') throw new Error(e.message);
      onEvent(e);
    }
  }
  throw new Error('The live connection closed early.');
}

/** The live step list while a message is on its way. */
function LiveView({ live }: { live: LiveState }) {
  // Keep the newest step in view as they arrive.
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [live.items.length]);
  return (
    <div className="cx-dbg-list">
      <div className="cx-dbg-outcome">
        <span className="cx-spin" /> <span className="small">{live.status}</span>
        <span className="cx-muted small">{ms(Date.now() - live.started)}{live.cost ? ` · ${money(live.cost)}` : ''}</span>
      </div>
      <div className="cx-dbg-sec">LIVE</div>
      {live.items.map((it) => (
        <Stage key={it.key} mark={it.mark === 'run' ? 'info' : it.mark} title={it.title} answer={it.mark === 'run' ? <span><span className="cx-spin" /> {it.answer}</span> : it.answer}>
          {it.detail ? <p className="cx-muted small">{it.detail}</p> : undefined}
        </Stage>
      ))}
      <div ref={end} />
    </div>
  );
}

let state: DebugState = { scenarioId: null, settings: null, logId: null, turns: [], raw: {}, rev: 0, live: null };
const listeners = new Set<() => void>();
export function setDebug(patch: Partial<DebugState> | ((s: DebugState) => Partial<DebugState>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useDebug = () => useSyncExternalStore(subscribe, () => state, () => state);

// ---------------------------------------------------------------- the panel

type Mark = 'pass' | 'block' | 'flag' | 'skip' | 'error' | 'info';
const MARK: Record<Mark, string> = { pass: '✓', block: '✕', flag: '!', skip: '–', error: '!', info: '•' };

/** One stage: a status mark, a title and a one-line answer, with details on click. */
function Stage({ mark, title, answer, children, open }: { mark: Mark; title: string; answer: ReactNode; children?: ReactNode; open?: boolean }) {
  const head = (
    <>
      <span className={`cx-dbg-mark ${mark}`} aria-label={mark}>
        {MARK[mark]}
      </span>
      <span className="cx-dbg-title">{title}</span>
      <span className="cx-dbg-answer">{answer}</span>
    </>
  );
  if (!children) return <div className="cx-dbg-stage flat">{head}</div>;
  return (
    <details className="cx-dbg-stage" open={open}>
      <summary>{head}</summary>
      <div className="cx-dbg-body">{children}</div>
    </details>
  );
}

const KV = ({ rows }: { rows: [string, ReactNode][] }) => (
  <dl className="cx-dbg-kv">
    {rows.map(([k, v]) => (
      <div key={k}>
        <dt>{k}</dt>
        <dd>{v}</dd>
      </div>
    ))}
  </dl>
);

export function StudioDebug({ id }: { id: number }) {
  const dbg = useDebug();
  const mine = dbg.scenarioId === id;
  const logId = mine ? dbg.logId : null;
  const turns = mine ? dbg.turns : [];
  const idx = turns.findIndex((t) => t.logId === logId);
  return (
    <div className="cx-dbg">
      <div className="cx-dbg-top">
        <Seg
          label="What to show"
          value={logId ? 'turn' : 'plan'}
          options={[
            ['plan', 'Planned'],
            ['turn', turns.length ? `Turn ${idx >= 0 ? idx + 1 : turns.length}` : 'Last turn'],
          ]}
          onChange={(v) => {
            writePref('studio.debug', v);
            setDebug({ logId: v === 'plan' ? null : (turns[turns.length - 1]?.logId ?? null) });
          }}
        />
        {logId && turns.length > 1 && (
          <span className="cx-dbg-step">
            <button type="button" className="cx-btn sm" disabled={idx <= 0} onClick={() => setDebug({ logId: turns[idx - 1].logId })} aria-label="Previous turn">
              ‹
            </button>
            <button type="button" className="cx-btn sm" disabled={idx < 0 || idx >= turns.length - 1} onClick={() => setDebug({ logId: turns[idx + 1].logId })} aria-label="Next turn">
              ›
            </button>
          </span>
        )}
      </div>
      {mine && dbg.live ? (
        <LiveView live={dbg.live} />
      ) : !mine || !dbg.settings ? (
        <Loading />
      ) : logId ? (
        <TurnView logId={logId} raw={dbg.raw[logId]} />
      ) : (
        <PlanView settings={dbg.settings} rev={dbg.rev} />
      )}
      {!logId && mine && turns.length === 0 && <p className="cx-details-empty">Send a message to see what the gateway did with it, stage by stage.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- before sending

function PlanView({ settings, rev }: { settings: ScenarioSettings; rev: number }) {
  const { data } = useStore();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const body = JSON.stringify({ keyId: settings.mode === 'key' ? settings.keyId : undefined, groupId: settings.mode === 'group' ? settings.groupId : undefined, model: settings.model, layers: settings.layers });
  // Reload when the scenario settings change, after each send, and when admin data changes.
  useEffect(() => {
    let live = true;
    api<Plan>('studio/plan', { body: JSON.parse(body) })
      .then((p) => live && (setPlan(p), setErr(null)))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [body, rev, data]);
  if (!plan) return <Loading error={err} />;
  const extra = data?.files.filter((f) => settings.extraContext.includes(f.id)) ?? [];
  const onLayers = plan.layers.filter((l) => l.on).length;
  return (
    <div className="cx-dbg-list">
      {err && <Note tone="bad">{err}</Note>}
      <div className="cx-dbg-sec">WHO IS ASKING</div>
      <Stage mark={plan.who.problem ? 'block' : 'pass'} title="Key" answer={`${plan.who.key} · ${plan.who.owner}`}>
        <KV rows={[['Sends as', plan.who.asGroup ? 'any key in this group (Studio)' : 'this key, without its secret'], ['Status', plan.who.problem ?? 'Active']]} />
      </Stage>
      <Stage mark="skip" title="IP check" answer="Skipped for Studio">
        <p className="cx-muted small">Studio acts as the key from inside the admin panel, so the key&apos;s IP allow-list does not apply. Real clients are checked.</p>
      </Stage>
      <Stage mark="info" title="Group" answer={plan.chain.map((g) => g.name).join(' › ')}>
        <p className="cx-muted small">Settings are read from the root down to the key&apos;s own group{plan.params.some((p) => p.cells.length > plan.chain.length) ? ', then the key’s own exceptions' : ''}.</p>
      </Stage>
      <Stage mark={plan.models.ok ? 'pass' : 'block'} title="Model" answer={plan.models.picked || 'none picked'}>
        <KV rows={[['Allowed', plan.models.ok ? 'yes' : 'no: the request will be rejected (403)'], ['Servers, in order', plan.models.servers.join(' → ') || '–'], ['Rate limit', `${plan.rateLimit} requests per minute`]]} />
        <span className="cx-field-label">Models this key can use · {plan.models.allowed.length}</span>
        <div className="cx-dbg-chips">
          {plan.models.allowed.map((m) => (
            <Pill key={m} tone={m === plan.models.picked ? 'info' : ''}>
              {m}
            </Pill>
          ))}
        </div>
      </Stage>

      <div className="cx-dbg-sec">GROUP SETTINGS</div>
      {plan.params.map((p) => (
        <Stage key={p.key} mark="info" title={p.label} answer={p.value}>
          <KV rows={[['Set by', p.from.join(' › ')]]} />
          <table className="cx-dbg-cells">
            <tbody>
              {p.cells.map((c, i) => (
                <tr key={i}>
                  <td>{c.group}</td>
                  <td>
                    <Pill tone={c.state === 'inherited' ? '' : c.state === 'add' ? 'ok' : 'info'}>{c.state}</Pill>
                  </td>
                  <td className="mono">{c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Stage>
      ))}

      <div className="cx-dbg-sec">CUSTOM RULES · {plan.rules.length}</div>
      {plan.rules.length === 0 && <p className="cx-details-empty">No rules apply to this group.</p>}
      {plan.rules.map((r) => (
        <Stage key={r.id} mark={r.action === 'block' ? 'block' : 'flag'} title={r.name} answer={r.action}>
          <KV rows={[['From', r.from], ['Looks in', r.target === 'any' ? 'user messages and tool results' : r.target === 'user' ? 'user messages' : 'tool results'], [r.match === 'regex' ? 'Regex' : 'Contains', <code key="p">{r.pattern}</code>]]} />
        </Stage>
      ))}

      <div className="cx-dbg-sec">
        GUARD LAYERS · {onLayers} OF {plan.layers.length} ON
      </div>
      {plan.layers.map((l) => (
        <Stage key={l.id} mark={l.on ? 'pass' : 'skip'} title={`${l.n}. ${l.name}`} answer={l.on ? `${l.type} · ${l.onFail}` : 'off'}>
          <KV
            rows={[
              ['State', l.why],
              ['Model', l.type === 'patterns' ? 'built-in patterns' : `${l.model || '–'}${l.server ? ` · ${l.server}` : ''}`],
              ['Adapter', l.adapter],
              ['When', l.stage === 'output' ? `after the model (checks the answer${l.onFail === 'retry' ? `, up to ${l.retries} retries` : ''})` : 'before the model'],
              ['Runs on', l.scope === 'all' ? 'every request' : 'only flagged requests'],
              ['On a hit', l.onFail],
              ['If it fails', l.onError],
              ['Threshold', l.threshold],
              ['Timeout', ms(l.timeoutMs)],
            ]}
          />
        </Stage>
      ))}
      <p className="cx-muted small cx-dbg-foot">A flag no later layer clears is {plan.unresolvedFlag === 'block' ? 'blocked' : 'allowed'}.</p>

      <div className="cx-dbg-sec">
        CONTEXT ADDED · {fmtTokens(plan.context.tokens)} TOKENS
      </div>
      <Stage mark={plan.context.identity ? 'pass' : 'skip'} title="Caller identity" answer={plan.context.identity ? 'first line' : 'off for this key'}>
        {plan.context.identity ? <pre className="cx-pre small">{plan.context.identity}</pre> : undefined}
      </Stage>
      <Stage mark={plan.context.policy.trim() ? 'pass' : 'skip'} title="Policy prompt" answer={plan.context.policy.trim() ? `${fmt(plan.context.policy.length)} chars` : 'empty'}>
        {plan.context.policy.trim() ? <pre className="cx-pre small">{plan.context.policy}</pre> : undefined}
      </Stage>
      {plan.context.files.length === 0 && <p className="cx-details-empty">No context files: the request goes on as sent.</p>}
      {plan.context.files.map((f) => (
        <Stage key={f.id} mark="pass" title={f.name} answer={`${fmtTokens(f.tokens)} · ${f.from}`}>
          <KV rows={[['Added by', f.from], ['Version', `v${f.version}`], ['Placement', plan.context.placement === 'top' ? 'top of the chat (cacheable)' : 'before the last message']]} />
          <pre className="cx-pre small">{f.body}</pre>
        </Stage>
      ))}
      {extra.length > 0 && (
        <Stage mark="info" title="Scenario's own files" answer={`${extra.length} sent as client content`}>
          <p className="cx-muted small">{extra.map((f) => f.name).join(', ')}</p>
        </Stage>
      )}

      <div className="cx-dbg-sec">IF IT IS BLOCKED</div>
      <pre className="cx-pre small">{plan.blockedReply}</pre>
    </div>
  );
}

// ---------------------------------------------------------------- after sending

/** Which stage a rejected or blocked request stopped at. */
function stopAt(l: LogEntry): 'key' | 'ip' | 'schema' | 'model' | 'rules' | 'layers' | null {
  const heads = (l.steps ?? []).map((s) => s.head);
  if (heads.some((h) => h === 'Rejected: no valid key')) return 'key';
  if (heads.some((h) => h === 'Rejected: address not allowed')) return 'ip';
  if (heads.some((h) => h === 'Rejected: wrong schema') || l.status_code === 400) return 'schema';
  if (heads.some((h) => h === 'Rejected: model not allowed' || h === 'Rejected: rate limit')) return 'model';
  if (l.outcome === 'blocked') return heads.some((h) => h.startsWith('Rule "') && h.endsWith('matched')) ? 'rules' : 'layers';
  return null;
}
const ORDER = ['key', 'ip', 'schema', 'model', 'rules', 'layers', 'context', 'upstream'] as const;

function TurnView({ logId, raw }: { logId: string; raw?: string }) {
  const [log, setLog] = useState<LogEntry | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setLog(null);
    api<LogEntry>(`logs/${logId}`)
      .then((l) => live && (setLog(l), setErr(null)))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [logId]);
  if (!log) return <Loading error={err} />;
  const stop = stopAt(log);
  const reached = (s: (typeof ORDER)[number]) => !stop || ORDER.indexOf(s) <= ORDER.indexOf(stop);
  const mark = (s: (typeof ORDER)[number]): Mark => (stop === s ? 'block' : reached(s) ? 'pass' : 'skip');
  const steps = log.steps ?? [];
  const find = (p: (h: string) => boolean) => steps.find((s) => p(s.head));
  const ruleSteps = steps.filter((s) => s.head.startsWith('Rule "') || s.head.startsWith('Redacted by'));
  const [label, tone] = OUTCOME[log.outcome] ?? [log.outcome, 'warn'];
  const decisions = log.decisions ?? [];
  const actMark = (a: string): Mark => (a === 'block' ? 'block' : a === 'flag' || a === 'redact' ? 'flag' : a === 'pass' || a === 'cleared' ? 'pass' : a === 'route' ? 'info' : 'skip');
  const upstream = steps.filter((s) => / unreachable$| returned \d+$|^Sent to the model/.test(s.head));
  return (
    <div className="cx-dbg-list">
      <div className="cx-dbg-outcome">
        <Pill tone={tone}>{label}</Pill>
        <span className="mono cx-muted small">{log.id}</span>
        <span className="cx-muted small">
          {ms(log.latency_ms)} · HTTP {log.status_code ?? '–'}
        </span>
      </div>
      {log.reason && <Note tone={log.outcome === 'blocked' || log.outcome === 'rejected' || log.outcome === 'error' ? 'bad' : undefined}>{log.reason}</Note>}

      <div className="cx-dbg-sec">STAGES, IN ORDER</div>
      <Stage mark={mark('key')} title="Key" answer={`${log.key_name ?? 'no key'} · ${log.owner ?? 'unknown'}`}>
        <p className="cx-muted small">{find((h) => h === 'Received' || h.startsWith('Rejected: no valid'))?.text ?? '–'}</p>
      </Stage>
      <Stage mark={stop === 'ip' ? 'block' : log.test ? 'skip' : mark('ip')} title="IP check" answer={log.ip ?? 'Not recorded'}>
        <p className="cx-muted small">{stop === 'ip' ? log.reason : log.test ? 'Studio traffic: the key’s IP allow-list is not applied.' : 'Allowed by the key’s IP list.'}</p>
      </Stage>
      <Stage mark={reached('schema') ? 'info' : 'skip'} title="Group" answer={log.group_name ?? '–'} />
      <Stage mark={mark('schema')} title="Format" answer={log.schema ?? '–'} />
      <Stage mark={mark('model')} title="Model access" answer={log.model ?? '–'}>
        <p className="cx-muted small">{stop === 'model' ? log.reason : 'This key may use the model.'}</p>
      </Stage>
      <Stage mark={stop === 'rules' ? 'block' : !reached('rules') ? 'skip' : ruleSteps.length ? 'flag' : 'pass'} title="Custom rules" answer={!reached('rules') ? 'not reached' : ruleSteps.length ? `${ruleSteps.length} matched` : 'none matched'}>
        {ruleSteps.length ? <Timeline steps={ruleSteps} /> : undefined}
      </Stage>
      {decisions.length === 0 && <Stage mark="skip" title="Guard layers" answer={reached('layers') ? 'none ran' : 'not reached'} />}
      {decisions.map((r) => (
        <Stage key={`${r.id}-${r.stage ?? 'input'}-${r.attempt ?? 0}`} mark={r.decision?.error ? 'error' : actMark(r.action)} title={`${r.n}. ${r.name}${r.stage === 'output' ? ` · answer #${r.attempt ?? 1}` : ''}`} answer={`${ACTION_LABEL[r.action] ?? r.action}${r.route ? ` → ${r.route.model ?? 'client model'}` : ''}${r.decision?.score != null ? ` · ${r.decision.score.toFixed(2)}` : ''}${r.decision ? ` · ${ms(r.decision.latency_ms)}` : ''}`}>
          {r.decision ? (
            <>
              <KV
                rows={[
                  ['Verdict', <Pill key="v" tone={ACTION_TONE[r.action]}>{r.decision.verdict}</Pill>],
                  ['Score', r.decision.score != null ? r.decision.score.toFixed(3) : '–'],
                  ['Categories', r.decision.categories.join(', ') || '–'],
                  ['Reason', r.decision.reason || '–'],
                  ['Time', ms(r.decision.latency_ms)],
                  ['Fallback used', r.fellBack ? 'yes' : 'no'],
                  ['Read', r.read?.length ? r.read.join(', ') : '–'],
                  ['Placement', r.decision.suffix ? `suffix, with ${r.decision.suffix.model}` : 'prefix'],
                  ['Prompt cache', r.decision.cache ? cacheLine(r.decision.cache) : '–'],
                  ...(r.decision.error ? ([['Error', r.decision.error]] as [string, ReactNode][]) : []),
                ]}
              />
              <span className="cx-field-label">Raw answer</span>
              <pre className="cx-pre small">{r.decision.raw || '(none: built-in layer or no call made)'}</pre>
            </>
          ) : (
            <p className="cx-muted small">{r.action === 'off' ? (r.bypassed ? 'Turned off for this group.' : 'Switched off.') : 'No call was made.'}</p>
          )}
        </Stage>
      ))}
      <Stage mark={!reached('context') ? 'skip' : log.injected ? 'pass' : 'info'} title="Context" answer={!reached('context') ? 'not reached' : log.injected ? `${fmtTokens(log.injected.tokens)} tokens added` : 'nothing added'}>
        {log.injected ? (
          <KV
            rows={[
              ...(log.injected.identity ? ([['Caller identity', log.injected.identity]] as [string, ReactNode][]) : []),
              ['Files', log.injected.files.map((f) => `${f.name} (${fmtTokens(f.tokens)})`).join(', ') || '–'],
              ['Policy prompt', log.injected.policy ? 'yes' : 'no'],
              ['Placement', log.injected.placement === 'top' ? 'top (cacheable)' : 'before the last message'],
            ]}
          />
        ) : undefined}
      </Stage>
      <Stage mark={!reached('upstream') ? 'skip' : log.outcome === 'error' ? 'error' : 'pass'} title="Model call" answer={!reached('upstream') ? 'not called' : `${log.server ?? '–'} · ${ms(log.stages?.upstream ?? null)}`}>
        <KV rows={[['Model', log.model ?? '–'], ['Server', log.server ?? '–'], ['Upstream time', ms(log.stages?.upstream ?? null)], ['Tokens out', fmt(log.tokens_out)], ['Prompt cache', (() => { const c = cacheOf(log.response); return c ? cacheLine(c) : '–'; })()], ['HTTP', log.status_code ?? '–']]} />
        {upstream.length > 0 && <Timeline steps={upstream} />}
      </Stage>
      <Stage mark={log.outcome === 'blocked' || log.outcome === 'rejected' ? 'block' : log.outcome === 'error' ? 'error' : log.outcome === 'answered' ? 'pass' : 'flag'} title="Outcome" answer={label} />

      <div className="cx-dbg-sec">MORE</div>
      <Stage mark="info" title="Every step" answer={`${steps.length} steps`}>
        <Timeline steps={steps} />
      </Stage>
      <Stage mark="info" title="Sent to the model" answer={log.forwarded ? `${log.forwarded.length} messages` : 'nothing'}>
        {log.forwarded ? <pre className="cx-pre small">{JSON.stringify(log.forwarded, null, 2)}</pre> : undefined}
      </Stage>
      {raw !== undefined && (
        <Stage mark="info" title="What the client received" answer={`${fmt(raw.length)} chars`}>
          <pre className="cx-pre small">{raw}</pre>
        </Stage>
      )}
      <Stage mark="info" title="Time per stage" answer={ms(log.latency_ms)}>
        <KV rows={Object.entries(log.stages ?? {}).map(([k, v]) => [k, ms(v)] as [string, ReactNode])} />
      </Stage>
    </div>
  );
}
