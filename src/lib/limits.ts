import { getDb, now } from './db';

/** Server and model rules: limits that apply to everyone, narrowest scope wins. */
export interface Limit {
  id: number;
  scope: 'global' | 'server' | 'model';
  server_id: number | null;
  model_name: string | null;
  rate_limit: number | null;
  allowed_groups: string | null;
  note: string;
  created_at: number;
}

export interface LimitView extends Omit<Limit, 'allowed_groups'> {
  allowedGroups: number[] | null;
}

const view = (l: Limit): LimitView => {
  const { allowed_groups, ...rest } = l;
  let allowedGroups: number[] | null = null;
  try {
    allowedGroups = allowed_groups ? (JSON.parse(allowed_groups) as number[]) : null;
  } catch {
    allowedGroups = null;
  }
  return { ...rest, allowedGroups };
};

export function listLimits(): LimitView[] {
  return (getDb().prepare('SELECT * FROM limits ORDER BY id').all() as Limit[]).map(view);
}

export function saveLimit(input: { id?: number; scope: Limit['scope']; serverId?: number | null; modelName?: string | null; rateLimit?: number | null; allowedGroups?: number[] | null; note?: string }) {
  if (!['global', 'server', 'model'].includes(input.scope)) throw new Error('Unknown scope.');
  if (input.scope !== 'global' && !input.serverId) throw new Error('Pick a server.');
  if (input.scope === 'model' && !input.modelName) throw new Error('Pick a model.');
  const rate = input.rateLimit ? Math.round(Number(input.rateLimit)) : null;
  if (rate !== null && (!Number.isFinite(rate) || rate < 1)) throw new Error('Rate limit must be at least 1 per minute.');
  const groups = input.allowedGroups && input.allowedGroups.length ? JSON.stringify(input.allowedGroups.map(Number)) : null;
  const db = getDb();
  const args = [input.scope, input.scope === 'global' ? null : input.serverId, input.scope === 'model' ? input.modelName : null, rate, groups, input.note ?? ''];
  if (input.id) {
    db.prepare('UPDATE limits SET scope = ?, server_id = ?, model_name = ?, rate_limit = ?, allowed_groups = ?, note = ? WHERE id = ?').run(...args, input.id);
    return input.id;
  }
  return Number(db.prepare('INSERT INTO limits (scope, server_id, model_name, rate_limit, allowed_groups, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...args, now()).lastInsertRowid);
}

export function deleteLimit(id: number) {
  getDb().prepare('DELETE FROM limits WHERE id = ?').run(id);
}

/**
 * Limits that bear on one (server, model) pair, broadest first.
 * Group restrictions must all pass; the narrowest rate limit wins.
 */
export function limitsFor(serverId: number, model: string, all = listLimits()) {
  const global = all.filter((l) => l.scope === 'global');
  const server = all.filter((l) => l.scope === 'server' && l.server_id === serverId);
  const mdl = all.filter((l) => l.scope === 'model' && l.server_id === serverId && l.model_name === model);
  const chain = [...global, ...server, ...mdl];
  const rate = [...chain].reverse().find((l) => l.rate_limit)?.rate_limit ?? null;
  return { chain, rate };
}

export function groupAllowed(chain: LimitView[], groupChain: number[]) {
  return chain.every((l) => !l.allowedGroups || l.allowedGroups.some((g) => groupChain.includes(g)));
}

// ---- in-memory sliding-window rate limiter ----

const g = globalThis as unknown as { __grRate?: Map<string, number[]> };
const buckets = (g.__grRate ??= new Map());

/** Returns true when the call is allowed, and records it. */
export function takeToken(bucket: string, perMinute: number, at = Date.now()): boolean {
  const cutoff = at - 60_000;
  const hits = (buckets.get(bucket) ?? []).filter((t: number) => t > cutoff);
  if (hits.length >= perMinute) {
    buckets.set(bucket, hits);
    return false;
  }
  hits.push(at);
  buckets.set(bucket, hits);
  return true;
}

export function resetRateLimits() {
  buckets.clear();
}
