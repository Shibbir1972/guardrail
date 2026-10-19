import { getDb, now } from './db';

export interface Server {
  id: number;
  name: string;
  url: string;
  api_key: string | null;
  role: 'inference' | 'guard';
  status: 'online' | 'down' | 'unknown';
  latency_ms: number | null;
  last_error: string | null;
  last_checked: number | null;
  cache_hit_rate: number | null;
  created_at: number;
}

export interface Model {
  id: number;
  server_id: number;
  name: string;
  context_len: number | null;
  enabled: number;
  present: number;
  discovered_at: number;
}

export interface DiscoveredModel {
  name: string;
  contextLen: number | null;
}

export function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/v1$/, '');
  // Throws on garbage so callers can return a clear error.
  new URL(u);
  return u;
}

function authHeaders(apiKey: string | null | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Ask a vLLM server which models it serves. */
export async function discover(url: string, apiKey?: string | null, timeoutMs = 5000) {
  const base = normalizeUrl(url);
  const t0 = performance.now();
  const res = await fetch(`${base}/v1/models`, {
    headers: authHeaders(apiKey),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  const latency = Math.round(performance.now() - t0);
  if (!res.ok) throw new Error(`Server answered ${res.status} ${res.statusText}`.trim());
  const body = (await res.json()) as { data?: { id: string; max_model_len?: number }[] };
  const models: DiscoveredModel[] = (body.data ?? []).map((m) => ({
    name: m.id,
    contextLen: typeof m.max_model_len === 'number' ? m.max_model_len : null,
  }));
  return { base, latency, models };
}

export function listServers(): Server[] {
  return getDb().prepare('SELECT * FROM servers ORDER BY role DESC, name').all() as Server[];
}

export function getServer(id: number): Server | undefined {
  return getDb().prepare('SELECT * FROM servers WHERE id = ?').get(id) as Server | undefined;
}

export function listModels(serverId?: number): Model[] {
  const db = getDb();
  return (serverId
    ? db.prepare('SELECT * FROM models WHERE server_id = ? ORDER BY name').all(serverId)
    : db.prepare('SELECT * FROM models ORDER BY name').all()) as Model[];
}

/** Every client-usable model with its server: enabled, still served, on an inference server. */
export function listModelsForRouting(): { name: string; server: Server }[] {
  const servers = new Map(listServers().filter((s) => s.role === 'inference').map((s) => [s.id, s]));
  return listModels()
    .filter((m) => m.enabled && m.present && servers.has(m.server_id))
    .map((m) => ({ name: m.name, server: servers.get(m.server_id)! }));
}

export function createServer(input: {
  name: string;
  url: string;
  apiKey?: string | null;
  role?: 'inference' | 'guard';
  models: DiscoveredModel[];
  enabled?: string[];
  latency?: number | null;
}): Server {
  const db = getDb();
  const name = input.name.trim();
  if (!name) throw new Error('Give the server a name.');
  const url = normalizeUrl(input.url);
  const tx = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO servers (name, url, api_key, role, status, latency_ms, last_checked, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, url, input.apiKey || null, input.role ?? 'inference', input.models.length ? 'online' : 'unknown', input.latency ?? null, now(), now());
    const id = Number(r.lastInsertRowid);
    const enabled = new Set(input.enabled ?? input.models.map((m) => m.name));
    const ins = db.prepare('INSERT INTO models (server_id, name, context_len, enabled, discovered_at) VALUES (?, ?, ?, ?, ?)');
    for (const m of input.models) ins.run(id, m.name, m.contextLen, enabled.has(m.name) ? 1 : 0, now());
    return id;
  });
  try {
    return getServer(tx())!;
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new Error(`A server named "${name}" already exists.`);
    throw e;
  }
}

export function updateServer(id: number, patch: { name?: string; url?: string; apiKey?: string | null; role?: 'inference' | 'guard' }) {
  const s = getServer(id);
  if (!s) throw new Error('Server not found.');
  getDb()
    .prepare('UPDATE servers SET name = ?, url = ?, api_key = ?, role = ? WHERE id = ?')
    .run(
      patch.name?.trim() || s.name,
      patch.url ? normalizeUrl(patch.url) : s.url,
      patch.apiKey === undefined ? s.api_key : patch.apiKey || null,
      patch.role ?? s.role,
      id,
    );
  return getServer(id)!;
}

export function deleteServer(id: number) {
  getDb().prepare('DELETE FROM servers WHERE id = ?').run(id);
}

export function setModelEnabled(modelId: number, enabled: boolean) {
  getDb().prepare('UPDATE models SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, modelId);
}

/** Re-run discovery: add new models (disabled until ticked), mark missing ones. */
export async function rediscover(id: number) {
  const s = getServer(id);
  if (!s) throw new Error('Server not found.');
  const db = getDb();
  try {
    const { latency, models } = await discover(s.url, s.api_key);
    const names = new Set(models.map((m) => m.name));
    let added = 0;
    const tx = db.transaction(() => {
      const existing = listModels(id);
      const have = new Set(existing.map((m) => m.name));
      for (const m of existing) db.prepare('UPDATE models SET present = ? WHERE id = ?').run(names.has(m.name) ? 1 : 0, m.id);
      for (const m of models) {
        if (have.has(m.name)) {
          db.prepare('UPDATE models SET context_len = ? WHERE server_id = ? AND name = ?').run(m.contextLen, id, m.name);
        } else {
          db.prepare('INSERT INTO models (server_id, name, context_len, enabled, discovered_at) VALUES (?, ?, ?, 0, ?)').run(id, m.name, m.contextLen, now());
          added++;
        }
      }
      db.prepare("UPDATE servers SET status = 'online', latency_ms = ?, last_error = NULL, last_checked = ? WHERE id = ?").run(latency, now(), id);
    });
    tx();
    return { ok: true as const, latency, found: models.length, newModels: added };
  } catch (e) {
    markDown(id, e);
    return { ok: false as const, error: errMsg(e) };
  }
}

export function markDown(id: number, e: unknown) {
  getDb().prepare("UPDATE servers SET status = 'down', last_error = ?, last_checked = ? WHERE id = ?").run(errMsg(e), now(), id);
}

export function markOnline(id: number, latency: number) {
  getDb().prepare("UPDATE servers SET status = 'online', latency_ms = ?, last_error = NULL, last_checked = ? WHERE id = ?").run(latency, now(), id);
}

/** Cheap health check plus prefix-cache stats from vLLM's Prometheus endpoint. */
export async function checkHealth(s: Server) {
  try {
    const t0 = performance.now();
    const res = await fetch(`${s.url}/v1/models`, { headers: authHeaders(s.api_key), signal: AbortSignal.timeout(3000), cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    markOnline(s.id, Math.round(performance.now() - t0));
  } catch (e) {
    markDown(s.id, e);
    return;
  }
  try {
    const m = await fetch(`${s.url}/metrics`, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    if (m.ok) {
      const rate = parsePrefixCacheRate(await m.text());
      if (rate !== null) getDb().prepare('UPDATE servers SET cache_hit_rate = ? WHERE id = ?').run(rate, s.id);
    }
  } catch {
    // Metrics are optional.
  }
}

/** Refresh any server not checked in the last `maxAgeMs`. Runs in the background. */
export function refreshStale(maxAgeMs = 30000) {
  const stale = listServers().filter((s) => !s.last_checked || now() - s.last_checked > maxAgeMs);
  return Promise.all(stale.map(checkHealth));
}

/** Handles both vLLM v1 counters and the older gauge. Returns 0..1 or null. */
export function parsePrefixCacheRate(text: string): number | null {
  const sum = (name: string) => {
    let total = 0;
    let seen = false;
    const re = new RegExp(`^${name.replace(/[:]/g, '\\:')}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, 'gm');
    for (const m of text.matchAll(re)) {
      total += parseFloat(m[1]);
      seen = true;
    }
    return seen ? total : null;
  };
  const hits = sum('vllm:prefix_cache_hits_total') ?? sum('vllm:gpu_prefix_cache_hits_total');
  const queries = sum('vllm:prefix_cache_queries_total') ?? sum('vllm:gpu_prefix_cache_queries_total');
  if (hits !== null && queries) return Math.max(0, Math.min(1, hits / queries));
  const gauge = sum('vllm:gpu_prefix_cache_hit_rate');
  return gauge === null ? null : Math.max(0, Math.min(1, gauge));
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    if (e.name === 'TimeoutError') return 'Timed out';
    if (cause?.code) return `${e.message} (${cause.code})`;
    return e.message;
  }
  return String(e);
}
