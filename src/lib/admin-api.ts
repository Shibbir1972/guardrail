import { env } from './env';
import { estimateTokens, createFile, deleteFile, fileHistory, getFile, listFiles, updateFile } from './context';
import { normalizeLayer } from './layers';
import { runPipeline } from './pipeline';
import { SETTING_DEFS, SettingKey, chainOf, createGroup, deleteGroup, getGroup, groupPath, listGroups, resolveGroup, setGroupSetting, updateGroup } from './groups';
import { cleanExceptions, createKey, deleteKey, getKey, listKeys, requestsToday, revealKey, rotateKey, updateKey } from './keys';
import { weakSecret } from './secret-box';
import { deleteLimit, groupAllowed, limitsFor, listLimits, saveLimit } from './limits';
import { getLog, overview, queryLogs, setFeedback, countByFilter, falseAlarmCount } from './logs';
import { createRule, deleteRule, listRules, updateRule } from './rules';
import { SCHEMAS, detectSchema } from './schemas';
import { type DiscoveredModel, addModelByHand, createServer, deleteServer, discover, errMsg, getServer, listModels, modelMeta, listServers, rediscover, refreshStale, setModelEnabled, setModelKind, updateServer, type ModelKind } from './servers';
import { getSettings, updateSettings } from './settings';
import { allowedRoutes, clientIp } from './gateway';
import { replayLog, runAsClient } from './client-run';
import { getDb } from './db';
import { publish, subscribe } from './events';
import { agentModels, createChat, deleteChat, getChat, listChats, listMessages, resolvePending, sendMessage, updateChat, type AgentEvent } from './agent/run';
import { applyUndo, listChanges, undoPlan } from './agent/changes';
import { checkAdmin, listSessions, logoutEverywhere, recentAudit, revokeFamily } from './auth';
import { probeFormat } from './adapters';
import { planFor } from './studio-plan';
import { createDoc, deleteDoc, docHistory, docsForKey, getDoc, listDocs, updateDoc } from './mcp-docs';
import { MCP_PATH, listTools, testAsKey } from './mcp';
import { groupKey } from './client-run';
import { createScenario, deleteScenario, duplicateScenario, listScenarios, scenarioFromLog, updateScenario } from './studio';

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

/** Logs with their full prompts for a date range, as JSONL (one session per line) or a JSON list. */
function exportLogs(url: URL): Response {
  const p = url.searchParams;
  const day = (s: string | null, end = false) => (s ? new Date(`${s}T${end ? '23:59:59.999' : '00:00:00'}`).getTime() : undefined);
  const labels = (p.get('labels') ?? '').split(',').filter(Boolean);
  const rows = queryLogs({ since: day(p.get('from')), until: day(p.get('to'), true), groups: groupScope(url), key: keyScope(url), feedback: labels.length ? labels : undefined, filter: p.get('filter') || undefined, test: testScope(url), limit: 5000 });
  const items = rows.map((r) => {
    const full = getLog(r.id) ?? r;
    return {
      id: r.id,
      time: new Date(r.ts).toISOString(),
      key: r.key_name,
      owner: r.owner,
      group: r.group_name,
      ip: r.ip,
      model: r.model,
      server: r.server,
      outcome: r.outcome,
      reason: r.reason,
      label: r.feedback,
      layers: full.decisions ?? null,
      injected: full.injected ?? null,
      prompt: full.prompt ?? null,
      sent_to_model: full.forwarded ?? null,
    };
  });
  const json = p.get('format') === 'json';
  const body = json ? JSON.stringify(items, null, 2) : items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '');
  const name = `guardrail-activity-${p.get('from') ?? 'all'}-${p.get('to') ?? 'now'}.${json ? 'json' : 'jsonl'}`;
  return new Response(body, { headers: { 'content-type': json ? 'application/json' : 'application/x-ndjson', 'content-disposition': `attachment; filename="${name}"`, 'x-row-count': String(items.length) } });
}

/** ?test=include|only shows Studio and replay traffic too; by default it is left out. */
const testScope = (url: URL) => (['include', 'only'].includes(url.searchParams.get('test') ?? '') ? (url.searchParams.get('test') as 'include' | 'only') : 'exclude');

/** ?key=<id>: one key's requests only. */
const keyScope = (url: URL) => Number(url.searchParams.get('key')) || undefined;

/** ?group=<id> as that group and its sub-groups; the root group (or none) means every log. */
function groupScope(url: URL): number[] | undefined {
  const id = Number(url.searchParams.get('group'));
  if (!id) return undefined;
  const groups = listGroups();
  const g = groups.find((x) => x.id === id);
  if (!g || g.parentId === null) return undefined;
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of groups)
      if (x.parentId !== null && ids.has(x.parentId) && !ids.has(x.id)) {
        ids.add(x.id);
        grew = true;
      }
  }
  return [...ids];
}

/** Writes that change nothing worth refreshing for (tests, previews, detection). The agent's own writes are announced by its tools. */
const QUIET = ['guard/test', 'guard/detect', 'keys/preview', 'schemas/detect', 'studio/plan', 'studio/live', 'studio/send', 'servers/discover', 'docs/test', 'agent/'];

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
      return { ok: true, url: r.base, latency: r.latency, models: r.models, notes: r.notes };
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
      models: Array.isArray(body.models) ? (body.models as DiscoveredModel[]) : [],
      enabled: Array.isArray(body.enabled) ? (body.enabled as string[]) : undefined,
      latency: typeof body.latency === 'number' ? body.latency : null,
    }),
  'PATCH servers/:id': ({ params, body }) =>
    updateServer(num(params[0]), { name: body.name as string, url: body.url as string, apiKey: body.apiKey as string | null | undefined, role: body.role as 'inference' | 'guard' }),
  'DELETE servers/:id': ({ params }) => deleteServer(num(params[0])),
  'POST servers/:id/models': ({ params, body }) => addModelByHand(num(params[0]), String(body.name ?? '')),
  'POST servers/:id/rediscover': ({ params }) => rediscover(num(params[0])),
  'PATCH models/:id': ({ params, body }) => {
    const id = num(params[0]);
    if ('kind' in body) setModelKind(id, (body.kind as ModelKind | null) || null);
    if ('enabled' in body) setModelEnabled(id, !!body.enabled);
    return { ok: true };
  },
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
    const servers = listServers().map((s) => ({ id: s.id, name: s.name }));
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
    createKey({ name: String(body.name ?? ''), owner: String(body.owner ?? ''), groupId: num(body.groupId, 'group'), exceptions: body.exceptions, expiresAt: body.expiresAt ? num(body.expiresAt, 'expiry') : null, ipAllow: body.ipAllow }),
  'PATCH keys/:id': ({ params, body }) =>
    updateKey(num(params[0]), {
      name: body.name as string,
      owner: body.owner as string,
      groupId: body.groupId === undefined ? undefined : num(body.groupId),
      exceptions: body.exceptions,
      expiresAt: body.expiresAt === undefined ? undefined : body.expiresAt === null ? null : num(body.expiresAt),
      revoked: body.revoked === undefined ? undefined : !!body.revoked,
      ipAllow: body.ipAllow,
      identity: body.identity && typeof body.identity === 'object' ? (body.identity as { key?: boolean; owner?: boolean }) : undefined,
      mcp: body.mcp === undefined ? undefined : !!body.mcp,
    }),
  'DELETE keys/:id': ({ params }) => deleteKey(num(params[0])),
  'GET keys/:id/secret': ({ params }) => {
    const secret = revealKey(num(params[0]));
    if (!secret) throw new HttpError(409, 'This key was created before secrets could be shown again, or with a different GUARDRAIL_SECRET. Rotate it to get a new secret you can view.');
    return { secret };
  },
  'POST keys/:id/rotate': ({ params }) => rotateKey(num(params[0])),
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
        return {
          ...g,
          context: r.effective.context,
          own: Array.isArray(g.settings.context?.value) ? (g.settings.context!.value as number[]) : [],
          mode: g.settings.context?.mode ?? null,
          ctxExclude: g.settings.context?.exclude ?? [],
          docs: r.effective.mcp_docs,
          docsExclude: g.settings.mcp_docs?.exclude ?? [],
          ownDocs: Array.isArray(g.settings.mcp_docs?.value) ? (g.settings.mcp_docs!.value as number[]) : [],
          docsMode: g.settings.mcp_docs?.mode ?? null,
          keys: keys.filter((k) => k.groupId === g.id).map((k) => k.name),
        };
      }),
      settings: getSettings(),
      cache: listServers().filter((s) => s.cache_hit_rate !== null).map((s) => ({ name: s.name, rate: s.cache_hit_rate })),
    };
  },
  'POST context': ({ body }) => createFile(String(body.name ?? ''), String(body.body ?? '')),
  'GET context/:id': ({ params }) => {
    const f = getFile(num(params[0]));
    if (!f) throw new HttpError(404, 'File not found.');
    return { file: f, history: fileHistory(f.id) };
  },
  'PATCH context/:id': ({ params, body }) => updateFile(num(params[0]), { name: body.name as string | undefined, body: body.body as string | undefined, autosave: body.autosave === true }),
  'DELETE context/:id': ({ params }) => {
    const id = num(params[0]);
    for (const g of listGroups()) {
      const s = g.settings.context;
      if (Array.isArray(s?.value) && (s.value as number[]).includes(id)) setGroupSetting(g.id, 'context', { mode: s.mode, value: (s.value as number[]).filter((x) => x !== id) });
    }
    deleteFile(id);
  },

  // ---- live updates ----
  // A server-sent event per change, so every open console view refreshes itself.
  'GET events': ({ req }) => {
    const enc = new TextEncoder();
    let stop = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const send = (s: string) => {
          try {
            c.enqueue(enc.encode(s));
          } catch {
            stop();
          }
        };
        send(': connected\n\n');
        const off = subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`));
        const ping = setInterval(() => send(': ping\n\n'), 25000);
        stop = () => {
          off();
          clearInterval(ping);
        };
        req.signal?.addEventListener('abort', stop);
      },
      cancel() {
        stop();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  },

  // ---- agent ----
  'GET agent/models': () => ({ models: agentModels() }),
  'GET agent/chats': ({ url }) => ({ chats: listChats(url.searchParams.get('q') ?? undefined) }),
  'POST agent/chats': ({ body }) => createChat((body.model as string) || null, body.serverId ? num(body.serverId, 'server') : null),
  'GET agent/chats/:id': ({ params }) => {
    const chat = getChat(num(params[0]));
    if (!chat) throw new HttpError(404, 'Chat not found.');
    return { chat, messages: listMessages(chat.id), changes: listChanges(chat.id) };
  },
  'PATCH agent/chats/:id': ({ params, body }) => updateChat(num(params[0]), { title: body.title as string | undefined, model: body.model as string | undefined, serverId: body.serverId === undefined ? undefined : body.serverId === null ? null : num(body.serverId, 'server') }),
  'DELETE agent/chats/:id': ({ params }) => deleteChat(num(params[0])),
  'POST agent/chats/:id/send': ({ params, body, req }) => {
    const text = String(body.text ?? '').trim();
    if (!text) throw new Error('Type a message first.');
    return agentStream(req, (emit, signal) => sendMessage(num(params[0]), text, emit, signal));
  },
  'POST agent/chats/:id/confirm': ({ params, body, req }) => agentStream(req, (emit, signal) => resolvePending(num(params[0]), String(body.pending ?? ''), body.approve === true, emit, signal)),
  'GET agent/chats/:id/undo': ({ params, url }) => ({ plan: undoPlan(num(params[0]), num(url.searchParams.get('turn'), 'turn'), url.searchParams.get('only') ? url.searchParams.get('only')!.split(',').map(Number) : undefined) }),
  'POST agent/chats/:id/undo': ({ params, body }) => {
    const r = applyUndo(num(params[0]), num(body.turn ?? 0, 'turn'), { force: Array.isArray(body.force) ? (body.force as number[]).map(Number) : [], only: Array.isArray(body.only) ? (body.only as number[]).map(Number) : undefined });
    // Undo writes straight to the tables: tell open consoles so trees and pages drop what was undone.
    if (r.done.length) publish({ source: 'agent', method: 'POST', path: `agent/chats/${params[0]}/undo` });
    return r;
  },

  // ---- admin sign-in ----
  'GET auth/sessions': () => ({ sessions: listSessions(), audit: recentAudit(30) }),
  'POST auth/sessions/:id/revoke': ({ params }) => revokeFamily(params[0], 'admin'),
  'POST auth/logout-all': ({ req }) => logoutEverywhere({ ip: clientIp(req), ua: req.headers.get('user-agent') }),

  // ---- MCP docs ----
  'GET docs': () => {
    const groups = listGroups();
    const docs = listDocs();
    const keys = listKeys();
    const reach = new Map<number, number>();
    const perKey = keys.map((k) => {
      const seen = docsForKey(k, groups, docs);
      for (const d of seen) reach.set(d.id, (reach.get(d.id) ?? 0) + 1);
      return { id: k.id, name: k.name, owner: k.owner, groupId: k.groupId, mcp: k.mcp, revoked: k.revoked, docs: seen.map((d) => d.id) };
    });
    return {
      endpoint: MCP_PATH,
      docs: docs.map((d) => ({
        ...d,
        groups: groups.filter((g) => Array.isArray(g.settings.mcp_docs?.value) && (g.settings.mcp_docs!.value as number[]).includes(d.id)).map((g) => g.id),
        keys: keys.filter((k) => Array.isArray(k.exceptions.mcp_docs?.value) && (k.exceptions.mcp_docs!.value as number[]).includes(d.id)).map((k) => k.id),
        reach: reach.get(d.id) ?? 0,
      })),
      keys: perKey,
      tools: listTools().map((t) => ({ name: t.name, title: t.title, description: t.description })),
    };
  },
  'POST docs': ({ body }) => createDoc(body as never),
  'GET docs/:id': ({ params }) => {
    const d = getDoc(num(params[0]));
    if (!d) throw new HttpError(404, 'Doc not found.');
    return { doc: d, history: docHistory(d.id) };
  },
  'PATCH docs/:id': ({ params, body }) =>
    updateDoc(num(params[0]), {
      title: body.title as string | undefined,
      slug: body.slug as string | undefined,
      description: body.description as string | undefined,
      tags: body.tags,
      body: body.body as string | undefined,
      autosave: body.autosave === true,
    }),
  'DELETE docs/:id': ({ params }) => {
    const id = num(params[0]);
    // Drop it from every group and key that lists it, then delete it.
    for (const g of listGroups()) {
      const s = g.settings.mcp_docs;
      if (Array.isArray(s?.value) && (s.value as number[]).includes(id)) setGroupSetting(g.id, 'mcp_docs', { mode: s.mode, value: (s.value as number[]).filter((x) => x !== id) });
    }
    for (const k of listKeys()) {
      const s = k.exceptions.mcp_docs;
      if (Array.isArray(s?.value) && (s.value as number[]).includes(id)) updateKey(k.id, { exceptions: { ...k.exceptions, mcp_docs: { ...s, value: (s.value as number[]).filter((x) => x !== id) } } });
    }
    deleteDoc(id);
  },
  // Run one MCP call as a key (or "any key in a group") and show what the agent would get.
  'POST docs/test': async ({ body }) => {
    const key = body.keyId ? getKey(num(body.keyId, 'key')) : body.groupId ? groupKey(num(body.groupId, 'group')) : undefined;
    if (!key) throw new HttpError(404, 'Pick a key or a group.');
    const method = String(body.method ?? 'tools/call');
    if (!['tools/list', 'tools/call', 'resources/list', 'resources/read', 'initialize'].includes(method)) throw new HttpError(400, 'Unsupported method.');
    return testAsKey(key, method, (body.params && typeof body.params === 'object' ? body.params : {}) as Record<string, unknown>);
  },

  // ---- settings and guard ----
  'GET settings': () => ({ settings: getSettings(), servers: serverView().map((s) => ({ id: s.id, name: s.name, role: s.role, status: s.status, latency_ms: s.latency_ms, models: s.models.map((m) => m.name) })), groups: treeOrder(groupsView()) }),
  'PATCH settings': ({ body }) => updateSettings(body),
  'GET guard/stats': () => {
    const since = Date.now() - 86400_000;
    const c = countByFilter(since);
    return { ...c, falseAlarms: falseAlarmCount(since) };
  },
  // One small probe to tell which response format a model speaks (costs one model call).
  'POST guard/detect': async ({ body }) => {
    const server = getServer(num(body.serverId, 'server'));
    if (!server) throw new HttpError(404, 'Server not found.');
    const model = String(body.model ?? '');
    if (!model) throw new Error('Pick a model first.');
    const meta = modelMeta(server.id, model);
    if (meta?.api === 'decisions') return { adapter: 'decisions', why: 'The server lists this model as Decisions-API only (no probe needed).', raw: '' };
    return probeFormat({ url: server.url, apiKey: server.api_key, model });
  },
  // How often a layer's suffix checks (and the model calls after them) hit the prompt cache lately.
  'GET guard/cache/:id': ({ params }) => {
    const id = params[0];
    const rows = getDb().prepare("SELECT decisions FROM request_logs WHERE decisions LIKE ? ORDER BY ts DESC LIMIT 200").all(`%"id":"${id.replace(/[%_"]/g, '')}"%`) as { decisions: string }[];
    let n = 0, cached = 0, prompt = 0, unreported = 0;
    for (const r of rows) {
      try {
        const d = (JSON.parse(r.decisions) as { id: string; decision?: { cache?: { cached: number | null; prompt: number } | null } }[]).find((x) => x.id === id)?.decision?.cache;
        if (d && d.prompt > 0) {
          if (d.cached === null || d.cached === undefined) unreported++;
          else {
            n++;
            cached += d.cached;
            prompt += d.prompt;
          }
        }
      } catch {
        // skip a broken row
      }
    }
    return { calls: n, cached, prompt, unreported, rate: prompt ? cached / prompt : null };
  },
  'POST guard/test': ({ body }) => guardTest(body),
  // The same, as a live event stream: each layer as it starts and finishes, then the result.
  'POST guard/test-live': ({ body }) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const send = (o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        try {
          send({ type: 'result', result: await guardTest(body, (e) => send({ type: 'layer', ...e })) });
        } catch (e) {
          send({ type: 'error', message: errMsg(e) });
        } finally {
          c.close();
        }
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  },


  // ---- activity ----
  'GET overview': ({ url }) => {
    const servers = listServers();
    return { ...overview(url.searchParams.get('range') ?? '24h', Date.now(), groupScope(url), keyScope(url)), servers: servers.map((s) => ({ id: s.id, name: s.name, url: s.url, role: s.role, status: s.status, latency_ms: s.latency_ms })) };
  },
  'GET logs': ({ url }) => {
    const p = url.searchParams;
    return {
      rows: queryLogs({ filter: p.get('filter') || undefined, q: p.get('q') || undefined, limit: Number(p.get('limit') ?? 200), before: p.get('before') ? Number(p.get('before')) : undefined, groups: groupScope(url), key: keyScope(url), test: testScope(url) }),
      counts: countByFilter(undefined, groupScope(url), testScope(url), keyScope(url)),
    };
  },
  'GET logs/:id': ({ params }) => {
    const l = getLog(params[0]);
    if (!l) throw new HttpError(404, 'Request not found.');
    return l;
  },
  'PATCH logs/:id': ({ params, body }) => setFeedback(params[0], (body.feedback as string) || null),
  'POST logs/:id/replay': ({ params, req }) => replayLog(params[0], undefined, clientIp(req)),
  'GET logs-export': ({ url }) => exportLogs(url),

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
  'GET studio/scenarios': () => ({ scenarios: listScenarios() }),
  'POST studio/scenarios': ({ body }) => (body.duplicateOf ? duplicateScenario(num(body.duplicateOf)) : body.fromLog ? scenarioFromLog(String(body.fromLog)) : createScenario(body as never)),
  'PATCH studio/scenarios/:id': ({ params, body }) => updateScenario(num(params[0]), body as never),
  'DELETE studio/scenarios/:id': ({ params }) => deleteScenario(num(params[0])),
  'POST studio/plan': ({ body }) =>
    planFor({
      keyId: body.keyId ? num(body.keyId, 'key') : undefined,
      groupId: body.groupId ? num(body.groupId, 'group') : undefined,
      model: String(body.model ?? ''),
      layers: Array.isArray(body.layers) ? body.layers.map(String) : null,
    }),
  // The same as studio/send, but as a live event stream: steps, layers, tokens, drafts, then the result.
  'POST studio/live': ({ body, req }) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        const send = (o: unknown) => {
          try {
            c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          } catch {
            // the page went away
          }
        };
        try {
          const run = await runAsClient({
            keyId: body.keyId ? num(body.keyId, 'key') : undefined,
            groupId: body.groupId ? num(body.groupId, 'group') : undefined,
            secret: typeof body.secret === 'string' ? body.secret : undefined,
            path: String(body.path ?? ''),
            body: body.body,
            headers: (body.headers as Record<string, string>) ?? {},
            source: 'Studio',
            ip: clientIp(req),
            layers: Array.isArray(body.layers) ? body.layers.map((l, i) => normalizeLayer(l as never, i)) : undefined,
            onEvent: send,
          });
          send({ type: 'result', run });
        } catch (e) {
          send({ type: 'error', message: errMsg(e) });
        } finally {
          c.close();
        }
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  },
  'POST studio/send': ({ body, req }) =>
    runAsClient({
      keyId: body.keyId ? num(body.keyId, 'key') : undefined,
      groupId: body.groupId ? num(body.groupId, 'group') : undefined,
      secret: typeof body.secret === 'string' ? body.secret : undefined,
      path: String(body.path ?? ''),
      body: body.body,
      headers: (body.headers as Record<string, string>) ?? {},
      source: 'Studio',
      ip: clientIp(req),
      layers: Array.isArray(body.layers) ? body.layers.map((l, i) => normalizeLayer(l as never, i)) : undefined,
    }),

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
      online: servers.filter((s) => s.status === 'online').length,
      servers: servers.length,
      groups: listGroups().length,
      keys: listKeys().filter((k) => !k.revoked).length,
      guard: getSettings().guard.layers.some((l) => l.enabled),
      blockedToday: countByFilter(Date.now() - 86400_000).blocked,
      name: env.adminName(),
      authEnabled: !!env.adminPassword(),
      weakSecret: weakSecret(),
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
  // Checked again here (not only in the middleware): a signed-out or revoked sign-in is refused.
  const auth = await checkAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 401 });
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
    // Tell open consoles something changed (reads, tests and streams that change nothing are skipped).
    if (req.method !== 'GET' && !QUIET.some((q) => parts.join('/').startsWith(q))) publish({ source: 'console', method: req.method, path: parts.join('/') });
    if (out instanceof Response) return out;
    return Response.json(out ?? { ok: true });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
  }
}


/** Run the guard layers on sample text with a group's settings (the "Try it" tester). Nothing is logged. */
async function guardTest(body: Record<string, unknown>, onLayer?: Parameters<typeof runPipeline>[0]['onLayer']) {
  const s = getSettings();
  const gid = body.groupId ? num(body.groupId) : listGroups()[0].id;
  const resolution = resolveGroup(gid);
  const segments = [{ source: (body.source === 'tool' ? 'tool result' : 'user message') as 'tool result' | 'user message', text: String(body.text ?? '') }];
  // Optionally try unsaved layers from the editor. Only layers before the model: there is no answer here.
  const layers = (Array.isArray(body.layers) ? body.layers.map((l, i) => normalizeLayer(l as never, i)) : s.guard.layers).filter((l) => l.stage !== 'output');
  // A layer with its own "reads" only sees the sample if it reads that kind of text.
  const segmentsFor = (scan: { user: boolean; tool: boolean }) => segments.filter((x) => (x.source === 'user message' ? scan.user : scan.tool));
  const pipe = await runPipeline({ segments, layers, resolution, escalate: null, unresolvedFlag: s.guard.unresolvedFlag, serverOf: (id) => getServer(id), metaOf: modelMeta, segmentsFor, onLayer });
  return { ...pipe, redact: pipe.redact.length, layers: layers.map((l) => ({ id: l.id, name: l.name })) };
}

/**
 * Call an admin route from inside the server (the agent's tools). The caller is already signed in;
 * this runs the same handler a console request would, with the same checks on its input.
 */
export async function invoke<T = unknown>(method: string, path: string, body: Record<string, unknown> = {}): Promise<T> {
  const [p, q] = path.split('?');
  const found = match(method, p.split('/').filter(Boolean));
  if (!found) throw new HttpError(404, `No such action: ${method} ${p}`);
  const url = new URL(`http://internal/api/admin/${p}${q ? `?${q}` : ''}`);
  const out = await found.h({ params: found.params, body, url, req: new Request(url, { method }) });
  if (method !== 'GET') publish({ source: 'agent', method, path: p });
  if (out instanceof Response) return (await out.json().catch(() => ({}))) as T;
  return (out ?? { ok: true }) as T;
}

/** Stream agent events as server-sent events; the client stopping the request stops the agent. */
function agentStream(req: Request, run: (emit: (e: AgentEvent) => void, signal: AbortSignal) => Promise<void>) {
  const enc = new TextEncoder();
  const ac = new AbortController();
  req.signal?.addEventListener('abort', () => ac.abort());
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      const send = (o: unknown) => {
        try {
          c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      try {
        await run(send, ac.signal);
      } catch (e) {
        send({ type: 'error', message: errMsg(e) });
      } finally {
        send({ type: 'done' });
        try {
          c.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      ac.abort();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}
