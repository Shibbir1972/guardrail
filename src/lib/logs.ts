import crypto from 'crypto';
import { getDb } from './db';

export type Outcome = 'answered' | 'false_alarm' | 'blocked' | 'redacted' | 'rejected' | 'error';

export interface Step {
  tone: 'neutral' | 'ok' | 'warn' | 'bad';
  head: string;
  ms: number;
  text: string;
  quote?: string;
  why?: string;
}

/** One message of a logged prompt. Completions requests are stored as a single user message. */
export interface PromptMessage {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

export interface LogEntry {
  id: string;
  ts: number;
  key_id: number | null;
  key_name: string | null;
  owner: string | null;
  group_id: number | null;
  group_name: string | null;
  ip: string | null;
  path: string | null;
  schema: string | null;
  model: string | null;
  server: string | null;
  c1_score: number | null;
  c1_status: string | null;
  c2_status: string | null;
  c2_reason: string | null;
  outcome: Outcome;
  status_code: number | null;
  reason: string | null;
  latency_ms: number | null;
  tokens_out: number | null;
  stages: Record<string, number>;
  steps: Step[];
  feedback: string | null;
  /** Only filled by getLog; lists leave the prompts out to stay small. */
  prompt?: PromptMessage[] | null;
  forwarded?: PromptMessage[] | null;
}

type Row = Omit<LogEntry, 'stages' | 'steps' | 'prompt' | 'forwarded'> & { stages: string; steps: string; prompt?: string | null; forwarded?: string | null };

/** Longest text kept per message. Agents resend whole files, so this caps how big one log row can get. */
export const PROMPT_TEXT_LIMIT = 200_000;

function capText(s: string) {
  return s.length > PROMPT_TEXT_LIMIT ? `${s.slice(0, PROMPT_TEXT_LIMIT)}\n\n[GuardRail: cut ${(s.length - PROMPT_TEXT_LIMIT).toLocaleString('en')} more characters from this log]` : s;
}

/** Copy of the messages that is safe to store: long text is cut. */
export function promptForLog(messages: unknown): PromptMessage[] | null {
  if (!Array.isArray(messages)) return null;
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return { content: capText(String(m)) };
    const msg = { ...(m as PromptMessage) };
    if (typeof msg.content === 'string') msg.content = capText(msg.content);
    else if (Array.isArray(msg.content))
      msg.content = msg.content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? { ...p, text: capText((p as { text: string }).text) } : p));
    return msg;
  });
}

const jsonOrNull = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export const newRequestId = () => 'req_' + crypto.randomBytes(6).toString('hex');

const COLS = ['id', 'ts', 'key_id', 'key_name', 'owner', 'group_id', 'group_name', 'ip', 'path', 'schema', 'model', 'server', 'c1_score', 'c1_status', 'c2_status', 'c2_reason', 'outcome', 'status_code', 'reason', 'latency_ms', 'tokens_out', 'stages', 'steps', 'feedback', 'prompt', 'forwarded'] as const;
const JSON_COLS = ['stages', 'steps', 'prompt', 'forwarded'];
// Everything but the prompts, for lists.
const LIST_COLS = COLS.filter((c) => c !== 'prompt' && c !== 'forwarded').join(', ');

export function writeLog(e: Partial<LogEntry> & { id: string; ts: number; outcome: Outcome }) {
  const row: Record<string, unknown> = { ...e, stages: JSON.stringify(e.stages ?? {}), steps: JSON.stringify(e.steps ?? []), prompt: jsonOrNull(e.prompt), forwarded: jsonOrNull(e.forwarded) };
  getDb()
    .prepare(`INSERT OR REPLACE INTO request_logs (${COLS.join(', ')}) VALUES (${COLS.map((c) => '@' + c).join(', ')})`)
    .run(Object.fromEntries(COLS.map((c) => [c, row[c] ?? null])));
}

export function updateLog(id: string, patch: Partial<LogEntry>) {
  const sets: string[] = [];
  const vals: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(patch)) {
    if (!(COLS as readonly string[]).includes(k) || k === 'id') continue;
    sets.push(`${k} = @${k}`);
    vals[k] = JSON_COLS.includes(k) ? jsonOrNull(v) : v;
  }
  if (sets.length) getDb().prepare(`UPDATE request_logs SET ${sets.join(', ')} WHERE id = @id`).run(vals);
}

const parse = (r: Row): LogEntry => {
  const { prompt, forwarded, ...rest } = r;
  const e: LogEntry = { ...rest, stages: safeJson(r.stages, {}), steps: safeJson(r.steps, []) };
  if ('prompt' in r) e.prompt = safeJson(prompt, null);
  if ('forwarded' in r) e.forwarded = safeJson(forwarded, null);
  return e;
};

function safeJson<T>(s: string | null | undefined, d: T): T {
  if (s === null || s === undefined) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
}

export function getLog(id: string): LogEntry | undefined {
  const r = getDb().prepare('SELECT * FROM request_logs WHERE id = ?').get(id) as Row | undefined;
  return r ? parse(r) : undefined;
}

export const OUTCOME_FILTERS: Record<string, Outcome[]> = {
  blocked: ['blocked', 'rejected'],
  false_alarm: ['false_alarm'],
  clean: ['answered', 'redacted'],
  error: ['error'],
};

export function queryLogs(opts: { filter?: string; q?: string; limit?: number; before?: number; since?: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  const outs = opts.filter ? OUTCOME_FILTERS[opts.filter] : undefined;
  if (outs) {
    where.push(`outcome IN (${outs.map(() => '?').join(',')})`);
    args.push(...outs);
  }
  if (opts.q) {
    where.push('(owner LIKE ? OR key_name LIKE ? OR group_name LIKE ? OR model LIKE ? OR id LIKE ? OR ip LIKE ?)');
    const like = `%${opts.q}%`;
    args.push(like, like, like, like, like, like);
  }
  if (opts.before) {
    where.push('ts < ?');
    args.push(opts.before);
  }
  if (opts.since) {
    where.push('ts >= ?');
    args.push(opts.since);
  }
  const sql = `SELECT ${LIST_COLS} FROM request_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ?`;
  args.push(Math.min(opts.limit ?? 100, 5000));
  return (getDb().prepare(sql).all(...args) as Row[]).map(parse);
}

export function countByFilter(since?: number) {
  const rows = getDb()
    .prepare(`SELECT outcome, COUNT(*) n FROM request_logs ${since ? 'WHERE ts >= ?' : ''} GROUP BY outcome`)
    .all(...(since ? [since] : [])) as { outcome: Outcome; n: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.outcome, r.n])) as Record<string, number>;
  const sum = (xs: Outcome[]) => xs.reduce((a, o) => a + (by[o] ?? 0), 0);
  return {
    all: rows.reduce((a, r) => a + r.n, 0),
    blocked: sum(OUTCOME_FILTERS.blocked),
    false_alarm: sum(OUTCOME_FILTERS.false_alarm),
    clean: sum(OUTCOME_FILTERS.clean),
    error: sum(OUTCOME_FILTERS.error),
  };
}

export const RANGES: Record<string, { ms: number; bucket: number; label: (d: Date) => string }> = {
  '1h': { ms: 3600_000, bucket: 5 * 60_000, label: (d) => hhmm(d) },
  '24h': { ms: 86400_000, bucket: 3600_000, label: (d) => hhmm(d) },
  '7d': { ms: 7 * 86400_000, bucket: 86400_000, label: (d) => d.toLocaleDateString('en', { weekday: 'short' }) },
  '30d': { ms: 30 * 86400_000, bucket: 86400_000, label: (d) => `${d.getMonth() + 1}/${d.getDate()}` },
};

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pct(xs: number[], p: number) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

export const STAGE_LABELS: Record<string, string> = {
  auth: 'Auth and key check',
  schema: 'Schema detection',
  access: 'Model access and limits',
  rules: 'Custom rules',
  piguard: 'Check 1 · PIGuard',
  oss: 'Check 2 · OSS (when flagged)',
  context: 'Context injection',
};

export function overview(range = '24h', at = Date.now()) {
  const R = RANGES[range] ?? RANGES['24h'];
  const since = at - R.ms;
  const prevCounts = countByFilter(since - R.ms);
  const counts = countByFilter(since);
  const prevAll = prevCounts.all - counts.all;
  const rows = getDb()
    .prepare('SELECT ts, outcome, stages FROM request_logs WHERE ts >= ? ORDER BY ts DESC LIMIT 20000')
    .all(since) as { ts: number; outcome: Outcome; stages: string }[];

  const first = Math.floor(since / R.bucket) * R.bucket;
  const n = Math.max(1, Math.ceil((at - first) / R.bucket));
  const req = Array.from({ length: n }, (_, i) => ({ t: first + i * R.bucket, label: R.label(new Date(first + i * R.bucket)), total: 0, blocked: 0 }));
  const stageVals: Record<string, number[]> = {};
  const overhead: number[] = [];
  for (const r of rows) {
    const i = Math.min(n - 1, Math.max(0, Math.floor((r.ts - first) / R.bucket)));
    req[i].total++;
    if (r.outcome === 'blocked' || r.outcome === 'rejected') req[i].blocked++;
    const st = safeJson<Record<string, number>>(r.stages, {});
    let o = 0;
    for (const [k, v] of Object.entries(st)) {
      if (k === 'upstream') continue;
      (stageVals[k] ??= []).push(v);
      if (k !== 'oss') o += v;
    }
    overhead.push(o);
  }
  const stages = Object.keys(STAGE_LABELS)
    .filter((k) => stageVals[k]?.length)
    .map((k) => ({ key: k, name: STAGE_LABELS[k], p50: median(stageVals[k])! }));
  const recentBlocks = queryLogs({ filter: 'blocked', limit: 6 });
  return {
    range,
    counts,
    change: prevAll > 0 ? Math.round(((counts.all - prevAll) / prevAll) * 100) : null,
    overheadP95: pct(overhead, 0.95),
    ossP50: median(stageVals.oss ?? []),
    buckets: req,
    stages,
    recentBlocks,
  };
}

export function setFeedback(id: string, feedback: string | null) {
  getDb().prepare('UPDATE request_logs SET feedback = ? WHERE id = ?').run(feedback, id);
}

export function falseAlarmCount(since: number) {
  return (getDb().prepare("SELECT COUNT(*) n FROM request_logs WHERE ts >= ? AND outcome = 'false_alarm'").get(since) as { n: number }).n;
}
