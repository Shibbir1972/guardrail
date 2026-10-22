import { estimateTokens, createFile, deleteFile, fileHistory, getFile, listFiles, updateFile } from './context';
import { builtinScore, runCheck1, runCheck2 } from './guard';
import { SETTING_DEFS, SettingKey, chainOf, createGroup, deleteGroup, getGroup, groupPath, listGroups, resolveGroup, setGroupSetting, updateGroup } from './groups';
import { cleanExceptions, createKey, deleteKey, getKey, listKeys, requestsToday, updateKey } from './keys';
import { deleteLimit, groupAllowed, limitsFor, listLimits, saveLimit } from './limits';
import { getLog, overview, queryLogs, setFeedback, countByFilter, falseAlarmCount } from './logs';
import { createRule, deleteRule, listRules, updateRule } from './rules';
import { SCHEMAS, detectSchema } from './schemas';
import { createServer, deleteServer, discover, errMsg, listModels, listServers, rediscover, refreshStale, setModelEnabled, updateServer } from './servers';
import { getSettings, updateSettings } from './settings';
import { allowedRoutes, handleCompletion, Trace } from './gateway';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Handler = (ctx: { params: string[]; body: Record<string, unknown>; url: URL; req: Request }) => unknown | Promise<unknown>;

const num = (v: unknown, what = 'id') => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new HttpError(400, `Bad ${what}.`);
  return n;
};

function serverView() {
  const models = listModels();
  return listServers().map((s) => ({
    ...s,
    api_key: s.api_key ? '••••••' : null,
    hasKey: !!s.api_key,
    models: models.filter((m) => m.server_id === s.id),
  }));
}

function groupsView() {
  const groups = listGroups();
  const keys = listKeys();
  return groups.map((g) => ({
    ...g,
    path: groupPath(g.id, groups),
    depth: chainOf(g.id, groups).length - 1,
    keyCount: keys.filter((k) => k.groupId === g.id).length,
    childCount: groups.filter((c) => c.parentId === g.id).length,
  }));
}

/** Depth-first order so the UI can draw the tree as a flat list. */
function treeOrder<T extends { id: number; parentId: number | null }>(groups: T[]): T[] {
  const out: T[] = [];
  const walk = (parent: number | null) => {
    for (const g of groups.filter((x) => x.parentId === parent)) {
      out.push(g);
      walk(g.id);
    }
  };
  walk(null);
  return out;
}

const routes: Record<string, Handler> = {
  // ---- servers and models ----
  'GET servers': () => {
    void refreshStale().catch(() => undefined);
    const groups = listGroups();
    const limits = listLimits();
    // Which groups can call each server's models, after inheritance and limits.
    const access: Record<string, string[]> = {};
    for (const g of groups) {
      const eff = resolveGroup(g.id, undefined, groups).effective;
      const gChain = chainOf(g.id, groups).map((x) => x.id);
      for (const m of listModels()) {
        if (eff.servers && !eff.servers.includes(m.server_id)) continue;
        if (!eff.models.includes('*') && !eff.models.includes(m.name)) continue;
        if (!groupAllowed(limitsFor(m.server_id, m.name, limits).chain, gChain)) continue;
        (access[m.id] ??= []).push(g.name);
      }
    }
    return { servers: serverView(), limits, groups: treeOrder(groupsView()), access };
  },
  'POST servers/discover': async ({ body }) => {
    try {
      const r = await discover(String(body.url ?? ''), (body.apiKey as string) || null);
      return { ok: true, url: r.base, latency: r.latency, models: r.models };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  },
  'POST servers': ({ body }) =>
    createServer({
      name: String(body.name ?? ''),
      url: String(body.url ?? ''),
      apiKey: (body.apiKey as string) || null,
      role: body.role === 'guard' ? 'guard' : 'inference',
      models: Array.isArray(body.models) ? (body.models as { name: string; contextLen: number | null }[]) : [],
      enabled: Array.isArray(body.enabled) ? (body.enabled as string[]) : undefined,
      latency: typeof body.latency === 'number' ? body.latency : null,
    }),
  'PATCH servers/:id': ({ params, body }) =>
    updateServer(num(params[0]), { name: body.name as string, url: body.url as string, apiKey: body.apiKey as string | null | undefined, role: body.role as 'inference' | 'guard' }),
  'DELETE servers/:id': ({ params }) => deleteServer(num(params[0])),
  'POST servers/:id/rediscover': ({ params }) => rediscover(num(params[0])),
  'PATCH models/:id': ({ params, body }) => setModelEnabled(num(params[0]), !!body.enabled),
  'POST limits': ({ body }) =>
    saveLimit({
      id: body.id ? num(body.id) : undefined,
      scope: body.scope as 'global',
      serverId: body.serverId ? num(body.serverId) : null,
      modelName: (body.modelName as string) || null,
      rateLimit: body.rateLimit ? num(body.rateLimit, 'rate limit') : null,
      allowedGroups: Array.isArray(body.allowedGroups) ? (body.allowedGroups as number[]) : null,
      note: String(body.note ?? ''),
    }),
  'DELETE limits/:id': ({ params }) => deleteLimit(num(params[0])),

  // ---- groups ----
  'GET groups': () => {
    const files = listFiles().map((f) => ({ id: f.id, name: f.name, tokens: estimateTokens(f.body) }));
    const servers = listServers().filter((s) => s.role === 'inference').map((s) => ({ id: s.id, name: s.name }));
    const models = [...new Set(listModels().filter((m) => m.enabled && servers.some((s) => s.id === m.server_id)).map((m) => m.name))].sort();
    const modelServers = Object.fromEntries(models.map((m) => [m, listModels().filter((x) => x.name === m && x.enabled).map((x) => servers.find((s) => s.id === x.server_id)?.name).filter(Boolean)]));
    return { groups: treeOrder(groupsView()), defs: SETTING_DEFS, files, servers, models, modelServers, settings: getSettings() };
  },
  'POST groups': ({ body }) => createGroup({ name: String(body.name ?? ''), parentId: body.parentId ? num(body.parentId) : null, description: String(body.description ?? '') }),
  'GET groups/:id': ({ params }) => {
    const id = num(params[0]);
    const g = getGroup(id);
    if (!g) throw new HttpError(404, 'Group not found.');
    const all = listGroups();
    const chain = chainOf(id, all);
    const keys = listKeys().filter((k) => k.groupId === id);
    return { group: g, chain: chain.map((c) => ({ id: c.id, name: c.name })), resolution: resolveGroup(id, undefined, all), keys };
  },
  'PATCH groups/:id': ({ params, body }) =>
    updateGroup(num(params[0]), { name: body.name as string, description: body.description as string, parentId: body.parentId === undefined ? undefined : num(body.parentId) }),
  'DELETE groups/:id': ({ params }) => deleteGroup(num(params[0])),
  'PUT groups/:id/settings': ({ params, body }) => {
    const key = String(body.key) as SettingKey;
    return setGroupSetting(num(params[0]), key, body.setting === null ? null : (body.setting as never));
  },

  // ---- keys ----
  'GET keys': () => {
    const groups = listGroups();
    const today = requestsToday();
    return {
      keys: listKeys().map((k) => ({ ...k, groupName: groups.find((g) => g.id === k.groupId)?.name ?? '?', groupPath: groupPath(k.groupId, groups), requestsToday: today.get(k.id) ?? 0 })),
      groups: treeOrder(groupsView()),
    };
  },
  'POST keys/preview': ({ body }) => {
    const gid = num(body.groupId);
    if (!getGroup(gid)) throw new HttpError(404, 'Group not found.');
    return resolveGroup(gid, cleanExceptions(body.exceptions));
  },
  'POST keys': ({ body }) =>
    createKey({ name: String(body.name ?? ''), owner: String(body.owner ?? ''), groupId: num(body.groupId, 'group'), exceptions: body.exceptions, expiresAt: body.expiresAt ? num(body.expiresAt, 'expiry') : null }),
  'PATCH keys/:id': ({ params, body }) =>
    updateKey(num(params[0]), {
      name: body.name as string,
      owner: body.owner as string,
      groupId: body.groupId === undefined ? undefined : num(body.groupId),
      exceptions: body.exceptions,
      expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt === null ? null : num(body.expiresAt),
      revoked: body.revoked === undefined ? undefined : !!body.revoked,
    }),
  'DELETE keys/:id': ({ params }) => deleteKey(num(params[0])),
  'GET keys/:id': ({ params }) => {
    const k = getKey(num(params[0]));
    if (!k) throw new HttpError(404, 'Key not found.');
    return { key: k, resolution: resolveGroup(k.groupId, k.exceptions) };
  },

  // ---- context files ----
  'GET context': () => {
    const groups = listGroups();
    const files = listFiles();
    const keys = listKeys();
    const used = (fid: number) => groups.filter((g) => resolveGroup(g.id, undefined, groups).effective.context.includes(fid));
    return {
      files: files.map((f) => ({ ...f, tokens: estimateTokens(f.body), usedBy: groups.filter((g) => { const s = g.settings.context; return Array.isArray(s?.value) && (s.value as number[]).includes(f.id); }).map((g) => g.name), reach: used(f.id).length })),
      groups: treeOrder(groupsView()).map((g) => {
        const r = resolveGroup(g.id, undefined, groups);
        return { ...g, context: r.effective.context, own: Array.isArray(g.settings.context?.value) ? (g.settings.context!.value as number[]) : [], mode: g.settings.context?.mode ?? null, keys: keys.filter((k) => k.groupId === g.id).map((k) => k.name) };
      }),
      settings: getSettings(),
      cache: listServers().filter((s) => s.role === 'inference' && s.cache_hit_rate !== null).map((s) => ({ name: s.name, rate: s.cache_hit_rate })),
    };
  },
  'POST context': ({ body }) => createFile(String(body.name ?? ''), String(body.body ?? '')),
  'GET context/:id': ({ params }) => {
    const f = getFile(num(params[0]));
    if (!f) throw new HttpError(404, 'File not found.');
    return { file: f, history: fileHistory(f.id) };
  },
  'PATCH context/:id': ({ params, body }) => updateFile(num(params[0]), { name: body.name as string | undefined, body: body.body as string | undefined }),
  'DELETE context/:id': ({ params }) => {
    const id = num(params[0]);
    for (const g of listGroups()) {
      const s = g.settings.context;
      if (Array.isArray(s?.value) && (s.value as number[]).includes(id)) setGroupSetting(g.id, 'context', { mode: s.mode, value: (s.value as number[]).filter((x) => x !== id) });
    }
    deleteFile(id);
  },

  // ---- settings and guard ----
  'GET settings': () => ({ settings: getSettings(), servers: serverView().map((s) => ({ id: s.id, name: s.name, role: s.role, status: s.status, latency_ms: s.latency_ms, models: s.models.map((m) => m.name) })), groups: treeOrder(groupsView()) }),
  'PATCH settings': ({ body }) => updateSettings(body),
  'GET guard/stats': () => {
    const since = Date.now() - 86400_000;
    const c = countByFilter(since);
    return { ...c, falseAlarms: falseAlarmCount(since) };
  },
  'POST guard/test': async ({ body }) => {
    const s = getSettings();
    const gid = body.groupId ? num(body.groupId) : listGroups()[0].id;
    const eff = resolveGroup(gid).effective;
    const segments = [{ source: (body.source === 'tool' ? 'tool result' : 'user message') as 'tool result' | 'user message', text: String(body.text ?? '') }];
    const c1 = await runCheck1(segments, s.guard);
    const flagged = c1.score >= eff.piguard_threshold;
    // Same routing as the gateway, for the chosen group: with PIGuard off, check 2 judges everything (if it is on).
    const c1On = s.guard.enabled && eff.piguard_enabled;
    const c2On = s.guard.enabled && eff.oss_enabled;
    const toCheck2 = c1On ? flagged : c2On;
    const c2 = toCheck2 ? await runCheck2(segments, c1On ? c1.quote : null, eff.oss_prompt, { ...s.guard, oss: { ...s.guard.oss, enabled: c2On } }) : null;
    return { threshold: eff.piguard_threshold, c1, c1On, c2On, flagged, c2, builtin: builtinScore(segments) };
  },

  // ---- activity ----
  'GET overview': ({ url }) => {
    const servers = listServers();
    return { ...overview(url.searchParams.get('range') ?? '24h'), servers: servers.map((s) => ({ id: s.id, name: s.name, url: s.url, role: s.role, status: s.status, latency_ms: s.latency_ms })) };
  },
  'GET logs': ({ url }) => {
    const p = url.searchParams;
    return {
      rows: queryLogs({ filter: p.get('filter') || undefined, q: p.get('q') || undefined, limit: Number(p.get('limit') ?? 200), before: p.get('before') ? Number(p.get('before')) : undefined }),
      counts: countByFilter(),
    };
  },
  'GET logs/:id': ({ params }) => {
    const l = getLog(params[0]);
    if (!l) throw new HttpError(404, 'Request not found.');
    return l;
  },
  'PATCH logs/:id': ({ params, body }) => setFeedback(params[0], (body.feedback as string) || null),

  // ---- rules ----
  'GET rules': () => ({ rules: listRules(), groups: treeOrder(groupsView()) }),
  'POST rules': ({ body }) => createRule(body as never),
  'PATCH rules/:id': ({ params, body }) => updateRule(num(params[0]), body as never),
  'DELETE rules/:id': ({ params }) => deleteRule(num(params[0])),

  // ---- studio ----
  'GET studio': () => {
    const groups = listGroups();
    return {
      keys: listKeys().map((k) => ({
        id: k.id,
        name: k.name,
        owner: k.owner,
        prefix: k.prefix,
        group: groupPath(k.groupId, groups),
        revoked: k.revoked,
        models: [...allowedRoutes(k, resolveGroup(k.groupId, k.exceptions, groups).effective).byModel.keys()].sort(),
      })),
      schemas: SCHEMAS,
    };
  },
  'POST studio/send': async ({ body }) => {
    const path = body.path === '/v1/completions' ? '/v1/completions' : '/v1/chat/completions';
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const [k, v] of Object.entries((body.headers as Record<string, string>) ?? {})) {
      try {
        headers.set(k, String(v));
      } catch {
        // ignore bad header names
      }
    }
    let key;
    if (body.keyId) {
      key = getKey(num(body.keyId, 'key'));
      if (!key) throw new HttpError(404, 'Key not found.');
    } else if (typeof body.secret === 'string' && body.secret.trim()) headers.set('authorization', `Bearer ${body.secret.trim()}`);
    const payload = typeof body.body === 'string' ? body.body : JSON.stringify(body.body ?? {});
    const trace: Trace = {};
    const t0 = Date.now();
    const res = await handleCompletion(new Request(`http://studio${path}`, { method: 'POST', headers, body: payload }), path === '/v1/completions' ? 'completions' : 'chat', { key, trace, source: 'Studio' });
    const raw = await res.text();
    const ms = Date.now() - t0;
    const sse = (res.headers.get('content-type') ?? '').includes('event-stream');
    let text = '';
    let error: string | null = null;
    try {
      if (sse) {
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
          const c = JSON.parse(line.slice(5)).choices?.[0];
          text += c?.delta?.content ?? c?.text ?? '';
        }
      } else {
        const j = JSON.parse(raw);
        if (j.error) error = j.error.message ?? String(j.error);
        else text = j.choices?.[0]?.message?.content ?? j.choices?.[0]?.text ?? '';
      }
    } catch {
      text = raw;
    }
    return {
      status: res.status,
      ms,
      streamed: sse,
      blocked: res.headers.get('x-guardrail-blocked') === '1',
      text,
      error,
      raw: raw.length > 20000 ? raw.slice(0, 20000) + '\n…' : raw,
      trace,
      log: trace.requestId ? getLog(trace.requestId) ?? null : null,
    };
  },

  // ---- schemas ----
  'GET schemas': () => ({ schemas: SCHEMAS, policy: getSettings().schemaPolicy }),
  'POST schemas/detect': ({ body }) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries((body.headers as Record<string, string>) ?? {})) {
      try {
        headers.set(k, String(v));
      } catch {
        // ignore bad header names
      }
    }
    let parsed: unknown = body.body;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch {
        throw new HttpError(400, 'The request body is not valid JSON.');
      }
    }
    return detectSchema(parsed, String(body.path ?? '/v1/chat/completions'), headers);
  },

  // ---- shell ----
  'GET summary': () => {
    const servers = listServers();
    return {
      online: servers.filter((s) => s.role === 'inference' && s.status === 'online').length,
      servers: servers.filter((s) => s.role === 'inference').length,
      groups: listGroups().length,
      keys: listKeys().filter((k) => !k.revoked).length,
      guard: getSettings().guard.piguard.enabled || getSettings().guard.oss.enabled,
      blockedToday: countByFilter(Date.now() - 86400_000).blocked,
      name: process.env.GUARDRAIL_ADMIN_NAME || 'Admin',
      authEnabled: !!process.env.GUARDRAIL_ADMIN_PASSWORD,
    };
  },
};

function match(method: string, parts: string[]) {
  for (const [sig, h] of Object.entries(routes)) {
    const [m, pattern] = sig.split(' ');
    if (m !== method) continue;
    const segs = pattern.split('/');
    if (segs.length !== parts.length) continue;
    const params: string[] = [];
    if (segs.every((s, i) => (s.startsWith(':') ? (params.push(decodeURIComponent(parts[i])), true) : s === parts[i]))) return { h, params };
  }
  return null;
}

export async function dispatch(req: Request, parts: string[]): Promise<Response> {
  const found = match(req.method, parts);
  if (!found) return Response.json({ error: 'Not found' }, { status: 404 });
  let body: Record<string, unknown> = {};
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    try {
      body = ((await req.json()) as Record<string, unknown>) ?? {};
    } catch {
      body = {};
    }
  }
  try {
    const out = await found.h({ params: found.params, body, url: new URL(req.url), req });
    return Response.json(out ?? { ok: true });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}

