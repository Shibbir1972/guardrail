import { getDb, now } from './db';
import type { Segment } from './guard';

export interface Rule {
  id: number;
  name: string;
  enabled: number;
  target: 'any' | 'user' | 'tool';
  match_type: 'contains' | 'regex';
  pattern: string;
  action: 'block' | 'redact' | 'escalate';
  group_id: number | null;
  message: string;
  hits: number;
  created_at: number;
}

export function listRules(): Rule[] {
  return getDb().prepare('SELECT * FROM rules ORDER BY id').all() as Rule[];
}

function validate(input: Partial<Rule>) {
  if (!input.name?.trim()) throw new Error('Give the rule a name.');
  if (!input.pattern?.trim()) throw new Error('Say what text the rule looks for.');
  if (input.match_type === 'regex') {
    try {
      new RegExp(input.pattern, 'i');
    } catch {
      throw new Error('That pattern is not a valid regular expression.');
    }
  }
  if (input.target && !['any', 'user', 'tool'].includes(input.target)) throw new Error('Unknown target.');
  if (input.action && !['block', 'redact', 'escalate'].includes(input.action)) throw new Error('Unknown action.');
}

export function createRule(input: Partial<Rule>): Rule {
  validate(input);
  const r = getDb()
    .prepare('INSERT INTO rules (name, enabled, target, match_type, pattern, action, group_id, message, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)')
    .run(input.name!.trim(), input.target ?? 'any', input.match_type ?? 'contains', input.pattern, input.action ?? 'block', input.group_id ?? null, input.message ?? '', now());
  return getDb().prepare('SELECT * FROM rules WHERE id = ?').get(Number(r.lastInsertRowid)) as Rule;
}

export function updateRule(id: number, patch: Partial<Rule>): Rule {
  const cur = getDb().prepare('SELECT * FROM rules WHERE id = ?').get(id) as Rule | undefined;
  if (!cur) throw new Error('Rule not found.');
  const next = { ...cur, ...patch };
  validate(next);
  getDb()
    .prepare('UPDATE rules SET name = ?, enabled = ?, target = ?, match_type = ?, pattern = ?, action = ?, group_id = ?, message = ? WHERE id = ?')
    .run(next.name, next.enabled ? 1 : 0, next.target, next.match_type, next.pattern, next.action, next.group_id, next.message, id);
  return getDb().prepare('SELECT * FROM rules WHERE id = ?').get(id) as Rule;
}

export function deleteRule(id: number) {
  getDb().prepare('DELETE FROM rules WHERE id = ?').run(id);
}

export function ruleRegex(r: Pick<Rule, 'match_type' | 'pattern'>): RegExp {
  return r.match_type === 'regex' ? new RegExp(r.pattern, 'gi') : new RegExp(r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
}

export interface RuleHit {
  rule: Rule;
  match: string;
  source: Segment['source'];
}

/** Rules that apply to a key in `groupChain` (root first), checked in id order. */
export function matchRules(segments: Segment[], groupChain: number[], rules = listRules()): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.group_id !== null && !groupChain.includes(r.group_id)) continue;
    let re: RegExp;
    try {
      re = ruleRegex(r);
    } catch {
      continue;
    }
    for (const s of segments) {
      if (r.target === 'user' && s.source !== 'user message') continue;
      if (r.target === 'tool' && s.source !== 'tool result') continue;
      re.lastIndex = 0;
      const m = re.exec(s.text);
      if (m) {
        hits.push({ rule: r, match: m[0].slice(0, 200), source: s.source });
        break;
      }
    }
  }
  return hits;
}

export function countHit(id: number) {
  getDb().prepare('UPDATE rules SET hits = hits + 1 WHERE id = ?').run(id);
}

/** Replace matches in every message's text with [REDACTED]. */
export function redactMessages<T extends { content?: unknown }>(messages: T[], rules: Rule[]): T[] {
  const res = rules.map(ruleRegex);
  const fix = (t: string) => res.reduce((acc, re) => acc.replace(re, '[REDACTED]'), t);
  return messages.map((m) => {
    if (typeof m.content === 'string') return { ...m, content: fix(m.content) };
    if (Array.isArray(m.content))
      return { ...m, content: m.content.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? { ...p, text: fix((p as { text: string }).text) } : p)) };
    return m;
  });
}
