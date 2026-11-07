import { EarlyStream } from './early-stream';
import { StreamCollector, responseFromJson } from './stream-collect';
import { cacheOf } from './adapters';
import { buildContextBlock, estimateTokens, filesByIds } from './context';
import { clientIp as ipOf, ipAllowed } from './ip';
import { contentText, newSegments, renderBlocked, Segment } from './guard';
import { type GuardLayer, RETRY_PROMPT } from './layers';
import { type LayerResult, applyRedactions, layerOn, runPipeline } from './pipeline';
import { chainOf, groupPath, listGroups, resolveGroup, Effective } from './groups';
import { ApiKey, checkKey, identityLine, lookupKey, touchKey } from './keys';
import { groupAllowed, limitsFor, listLimits, takeToken } from './limits';
import { LogEntry, Outcome, Step, newRequestId, promptForLog, updateLog, writeLog } from './logs';
import { countHit, matchRules, redactMessages } from './rules';
import { detectSchema, schemaForPath } from './schemas';
import { getDb } from './db';
import { errMsg, getServer, listModelsForRouting, markDown, modelMeta, Server } from './servers';
import { getSettings } from './settings';
import { apiError, blockedResponse, sseFromJson } from './sse';

type Msg = { role?: string; content?: unknown };
type Kind = 'chat' | 'completions';

/** What the Studio page shows about a request beyond its log entry. */
export interface Trace {
  requestId?: string;
  group?: string;
  context?: { name: string; tokens: number }[];
  contextTokens?: number;
  placement?: 'top' | 'end';
  forwarded?: unknown;
}

export interface GatewayOptions {
  /** Act as this key without its secret (admin Studio only). */
  key?: ApiKey;
  /** Filled in as the request moves through the gateway. */
  trace?: Trace;
  /** Marks the request as test traffic (Studio, replay). */
  source?: string;
  /** For test traffic: the address of the admin who sent it. */
  ip?: string | null;
  /** Run these guard layers instead of the saved ones (Studio, replay). */
  layers?: GuardLayer[];
  /** Live progress for Studio: each step, layer, model call and draft answer as it happens. */
  onEvent?: (e: LiveEvent) => void;
}

export type LiveEvent =
  | { type: 'step'; step: Step }
  | { type: 'layer'; phase: 'start' | 'done'; id: string; name: string; n: number; stage: 'input' | 'output'; attempt?: number; result?: LayerResult }
  | { type: 'model'; attempt: number; model: string }
  | { type: 'draft'; attempt: number; text: string; toolCalls: number; cache: { cached: number; prompt: number } | null; cost: number | null };

export function clientIp(req: Request): string | null {
  return ipOf(req.headers, getSettings().trustProxy);
}

export function bearer(req: Request): string | null {
  const a = req.headers.get('authorization');
  if (a?.toLowerCase().startsWith('bearer ')) return a.slice(7).trim() || null;
  return req.headers.get('x-api-key')?.trim() || null;
}

/** Put the context block where vLLM can cache it: the very start of the prompt. */
/**
 * The OpenRouter provider that last answered each server and model, to keep prompt caches warm.
 * Kept on globalThis so a dev-server code reload doesn't forget it (which made every call cold).
 */
const lastProvider: Map<string, string> = ((globalThis as { __grLastProvider?: Map<string, string> }).__grLastProvider ??= new Map());

/** Put a cache breakpoint (Anthropic-style cache_control) on the last message's text. */
export function withCacheBreakpoint(messages: Msg[]): Msg[] {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  const parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : Array.isArray(last.content) ? [...(last.content as Record<string, unknown>[])] : null;
  if (!parts?.length) return messages;
  parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { type: 'ephemeral' } };
  return [...messages.slice(0, -1), { ...last, content: parts }];
}

export function injectContext(messages: Msg[], block: string, placement: 'top' | 'end'): Msg[] {
  if (!block) return messages;
  if (placement === 'end') {
    const i = messages.map((m) => m.role).lastIndexOf('user');
    if (i < 0) return [...messages, { role: 'user', content: block }];
    const m = messages[i];
    const content = Array.isArray(m.content) ? [{ type: 'text', text: block }, ...m.content] : `${block}\n\n${contentText(m.content)}`;
    return [...messages.slice(0, i), { ...m, content }, ...messages.slice(i + 1)];
  }
  const first = messages[0];
  if (first && (first.role === 'system' || first.role === 'developer')) {
    const content = Array.isArray(first.content) ? [{ type: 'text', text: block }, ...first.content] : `${block}\n\n${contentText(first.content)}`;
    return [{ ...first, content }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: block }, ...messages];
}

/** A completions prompt (string or list of strings) as messages, so the log can show it like chat. */
function promptMessages(prompt: unknown): Msg[] | undefined {
  if (prompt === undefined || prompt === null) return undefined;
  const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? prompt.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n') : JSON.stringify(prompt);
  return [{ role: 'user', content: text }];
}

/** Which models a key may call, by name, with the servers that serve each. */
export function allowedRoutes(key: ApiKey, eff: Effective) {
  const groups = listGroups();
  const groupChain = chainOf(key.groupId, groups).map((g) => g.id);
  const limits = listLimits();
  const all = listModelsForRouting();
  const byModel = new Map<string, { server: Server; rate: number | null }[]>();
  for (const r of all) {
    if (eff.servers && !eff.servers.includes(r.server.id)) continue;
    if (!eff.models.includes('*') && !eff.models.includes(r.name)) continue;
    const lim = limitsFor(r.server.id, r.name, limits);
    if (!groupAllowed(lim.chain, groupChain)) continue;
    const list = byModel.get(r.name) ?? [];
    list.push({ server: r.server, rate: lim.rate });
    byModel.set(r.name, list);
  }
  // Healthy servers first; ones marked down are tried last.
  for (const list of byModel.values()) list.sort((a, b) => Number(a.server.status === 'down') - Number(b.server.status === 'down'));
  return { byModel, groupChain };
}

/**
 * The body for the buffered call that after-the-model layers make: the answer is collected whole, so it is
 * not streamed. vLLM (and others) reject `stream_options` unless `stream` is true, and streaming clients such
 * as Cline always send it, so it is dropped here.
 */
export function nonStreaming(b: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...b, stream: false };
  delete rest.stream_options;
  return rest;
}

/**
 * A chat request. For a streaming client that goes through guard layers, the reply stream is opened before the
 * layers have finished (see early-stream.ts) and the waiting is shown as thinking; everything else is answered
 * as soon as the result is known.
 */
export async function handleCompletion(req: Request, kind: Kind, opts: GatewayOptions = {}): Promise<Response> {
  const early = kind === 'chat' && !opts.source ? new EarlyStream() : null;
  const result = run(req, kind, opts, early);
  if (!early) return result;
  const first = await Promise.race([result.then((r) => ({ r })), early.opened.then(() => null)]);
  if (first) return first.r;
  return early.response(result);
}

async function run(req: Request, kind: Kind, opts: GatewayOptions, early: EarlyStream | null): Promise<Response> {
  const id = newRequestId();
  const trace = opts.trace ?? {};
  trace.requestId = id;
  const t0 = performance.now();
  const at = () => Math.round((performance.now() - t0) * 10) / 10;
  let last = 0;
  // Time since the previous lap: each stage's own cost.
  const lap = () => {
    const t = at();
    const d = Math.round((t - last) * 10) / 10;
    last = t;
    return d;
  };
  const settings = getSettings();
  const path = new URL(req.url).pathname;
  const steps: Step[] = [];
  const emit = opts.onEvent;
  if (emit) {
    const push = steps.push.bind(steps);
    steps.push = (...xs: Step[]) => {
      for (const x of xs) emit({ type: 'step', step: x });
      return push(...xs);
    };
  }
  const stages: Record<string, number> = {};
  const log: Partial<LogEntry> & { id: string; ts: number } = { id, ts: Date.now(), ip: opts.source ? (opts.ip ?? null) : clientIp(req), path, test: !!opts.source };

  const finish = (outcome: Outcome, status: number, reason: string | null, extra: Partial<LogEntry> = {}) =>
    writeLog({ ...log, ...extra, outcome, status_code: status, reason, latency_ms: Math.round(at()), stages, steps });

  // 1. Who is calling
  const found = opts.key ? checkKey(opts.key) : lookupKey(bearer(req));
  stages.auth = lap();
  if (!found.ok) {
    steps.push({ tone: 'bad', head: 'Rejected: no valid key', ms: at(), text: `${found.reason} From ${log.ip ?? 'an unknown address'}. The checks and the model were never reached.` });
    finish('rejected', 401, found.reason, { key_id: found.key?.id ?? null, key_name: found.key?.name ?? null, owner: found.key?.owner ?? null, c1_status: 'not_run', c2_status: 'not_run' });
    return apiError(401, found.reason, 'authentication_error', id, 'invalid_api_key');
  }
  const key = found.key;
  // Studio acts as a key from inside the admin panel, so the key's IP list does not apply to it.
  if (!opts.source && !ipAllowed(log.ip ?? null, key.ipAllow)) {
    const reason = `This key can only be used from ${key.ipAllow.join(', ')}. The request came from ${log.ip ?? 'an unknown address'}.`;
    steps.push({ tone: 'bad', head: 'Rejected: address not allowed', ms: at(), text: reason });
    finish('rejected', 403, reason, { key_id: key.id, key_name: key.name, owner: key.owner, group_id: key.groupId, c1_status: 'not_run', c2_status: 'not_run' });
    return apiError(403, reason, 'permission_error', id, 'ip_not_allowed');
  }
  touchKey(key.id);
  const groups = listGroups();
  const gpath = groupPath(key.groupId, groups);
  trace.group = gpath;
  Object.assign(log, { key_id: key.id, key_name: key.name, owner: key.owner, group_id: key.groupId, group_name: groups.find((g) => g.id === key.groupId)?.name ?? null });
  steps.push({ tone: 'neutral', head: 'Received', ms: 0, text: `Key ${key.name} (${key.owner}), group ${gpath}${log.ip ? `, IP ${log.ip}` : ''}` });

  // 2. What format it is in
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    finish('rejected', 400, 'Body is not valid JSON');
    return apiError(400, 'Request body is not valid JSON.', 'invalid_request_error', id);
  }
  log.model = typeof body.model === 'string' ? body.model : null;
  log.prompt = promptForLog(kind === 'chat' ? body.messages : promptMessages(body.prompt));
  const det = detectSchema(body, path, req.headers);
  const expected = schemaForPath(path)!;
  log.schema = det.best.id;
  stages.schema = lap();
  if (det.best.id !== expected.id && det.confidence >= 0.6 && settings.schemaPolicy === 'strict') {
    const msg = `Strict schema: got ${path} but the body looks like ${det.best.name} (${Math.round(det.confidence * 100)}%). Send ${expected.name} to this endpoint.`;
    steps.push({ tone: 'bad', head: 'Rejected: wrong schema', ms: at(), text: msg });
    finish('rejected', 422, msg, { c1_status: 'not_run', c2_status: 'not_run' });
    return apiError(422, msg, 'invalid_request_error', id, 'schema_mismatch');
  }

  // 3. What this key may do
  const res = resolveGroup(key.groupId, key.exceptions, groups);
  const eff = res.effective;
  let model = String(body.model ?? '');
  log.model = model || null;
  const { byModel } = allowedRoutes(key, eff);
  let routes = byModel.get(model);
  if (!routes?.length) {
    const allowed = [...byModel.keys()];
    const msg = model
      ? `This key cannot use the model "${model}". ${allowed.length ? `It can use: ${allowed.join(', ')}.` : 'It has no models yet; ask your admin.'}`
      : 'The request names no model.';
    steps.push({ tone: 'bad', head: 'Rejected: model not allowed', ms: at(), text: msg });
    finish('rejected', 403, msg, { c1_status: 'not_run', c2_status: 'not_run' });
    return apiError(403, msg, 'permission_error', id, 'model_not_allowed');
  }
  if (!takeToken(`key:${key.id}`, eff.rate_limit) || (routes[0].rate && !takeToken(`key:${key.id}:m:${routes[0].server.id}:${model}`, routes[0].rate))) {
    const msg = `Rate limit reached for this key (${routes[0].rate && routes[0].rate < eff.rate_limit ? routes[0].rate : eff.rate_limit} requests per minute).`;
    steps.push({ tone: 'bad', head: 'Rejected: rate limit', ms: at(), text: msg });
    finish('rejected', 429, msg, { c1_status: 'not_run', c2_status: 'not_run' });
    return apiError(429, msg, 'rate_limit_error', id, 'rate_limit_exceeded');
  }

  const stream = body.stream === true;
  let messages: Msg[] = kind === 'chat' ? (Array.isArray(body.messages) ? (body.messages as Msg[]) : []) : [{ role: 'user', content: contentText(body.prompt) || (Array.isArray(body.prompt) ? (body.prompt as unknown[]).join('\n') : '') }];
  const segments: Segment[] = newSegments(messages, settings.guard.scan);

  const block = (reason: string, extra: Partial<LogEntry>) => {
    const text = renderBlocked(eff.blocked_reply, reason, id, settings.guard.reply.includeReason);
    steps.push({ tone: 'bad', head: `Blocked reply ${stream ? 'streamed' : 'sent'} to the client`, ms: at(), text: 'The model was never called. The client was shown:', quote: text });
    finish('blocked', 200, reason, { ...extra, response: { message: { role: 'assistant', content: text }, finish_reason: 'stop', blocked: true } });
    return blockedResponse({ stream, model, text, requestId: id, kind, roleSent: !!early?.active });
  };

  stages.access = lap();

  // 4. Custom rules
  const hits = matchRules(segments, chainOf(key.groupId, groups).map((g) => g.id));
  stages.rules = lap();
  let redacted = false;
  for (const h of hits) countHit(h.rule.id);
  const blockHit = hits.find((h) => h.rule.action === 'block');
  if (blockHit) {
    steps.push({ tone: 'bad', head: `Rule "${blockHit.rule.name}" matched`, ms: at(), text: `Matched in a ${blockHit.source}:`, quote: blockHit.match });
    return block(blockHit.rule.message || `Matched the rule "${blockHit.rule.name}".`, { c1_status: 'not_run', c2_status: 'not_run' });
  }
  const redactHits = hits.filter((h) => h.rule.action === 'redact');
  if (redactHits.length) {
    messages = redactMessages(messages, redactHits.map((h) => h.rule));
    redacted = true;
    steps.push({ tone: 'warn', head: `Redacted by ${redactHits.map((h) => `"${h.rule.name}"`).join(', ')}`, ms: at(), text: 'Matching text was replaced with [REDACTED] before the request went on.' });
  }
  const escHit = hits.find((h) => h.rule.action === 'escalate');
  if (escHit) {
    steps.push({ tone: 'warn', head: `Rule "${escHit.rule.name}" flagged it for the guard layers`, ms: at(), text: `Matched in a ${escHit.source}:`, quote: escHit.match });
  }

  // 5. Guard layers, in order (see pipeline.ts). The first two are the classic PIGuard + judge pair.
  let outcome: Outcome = redacted ? 'redacted' : 'answered';
  const groupName = groups.find((x) => x.id === key.groupId)?.name ?? 'this group';
  const allLayers = opts.layers ?? settings.guard.layers;
  // Layers before the model check the request; "after the model" layers check its answer (step 7b).
  const layers = allLayers.filter((l) => l.stage !== 'output');
  const outLayers = kind === 'chat' ? allLayers.filter((l) => l.stage === 'output' && layerOn(l, eff)) : [];
  // The context block and the message list the model gets, built once by one function, so a
  // "suffix" guard layer sends exactly the same prefix as the real call (and shares its cache).
  const files = filesByIds(eff.context);
  // The caller line (key's own setting) goes first, then the policy prompt and the context files.
  const identity = identityLine(key);
  const ctx = [identity, buildContextBlock(settings.policyPrompt, files)].filter(Boolean).join('\n\n');
  const suffixOn = kind === 'chat' && allLayers.some((l) => (l.placement === 'suffix' || l.stage === 'output') && layerOn(l, eff));
  const forwardMessages = (msgs: Msg[]) => {
    const m = ctx ? injectContext(msgs, ctx, settings.contextPlacement) : msgs;
    // Anthropic and Gemini models only cache from explicit breakpoints: mark the end of the shared part.
    return suffixOn && /anthropic\/|claude|gemini/i.test(model) ? withCacheBreakpoint(m) : m;
  };
  // OpenRouter spreads a model over several providers, each with its own cache. For suffix checks ask
  // for the provider that served this model last, so the check and the call land on the same cache.
  const onOpenRouter = /openrouter\.ai/i.test(routes[0].server.url);
  const stickyKey = `${routes[0].server.id}::${model}`;
  if (suffixOn && onOpenRouter && !body.provider && lastProvider.get(stickyKey)) body.provider = { order: [lastProvider.get(stickyKey)], allow_fallbacks: true };
  const conversation = suffixOn ? { body: { ...body, model, messages: forwardMessages(messages) }, model, serverId: routes[0].server.id } : null;
  if (early && stream && kind === 'chat' && (layers.some((l) => layerOn(l, eff)) || outLayers.length > 0)) {
    early.open({ id, model });
    early.onCancel = (sec, phase) => steps.push({ tone: 'warn', head: 'Client stopped waiting', ms: at(), text: `The client closed the connection ${sec} s after the reply stream opened, while the gateway was ${phase}.` });
    early.status('Security check: reading your request…', 'checking the request');
  }
  const pipe = await runPipeline({
    conversation,
    onLayer: emit ? (e) => emit({ type: 'layer', ...e, stage: 'input' }) : undefined,
    segments,
    layers,
    resolution: res,
    escalate: escHit ? { quote: escHit.match } : null,
    unresolvedFlag: settings.guard.unresolvedFlag,
    serverOf: (sid) => getServer(sid),
    segmentsFor: (scan) => newSegments(messages, scan),
    metaOf: modelMeta,
  });
  log.decisions = pipe.results;
  for (const r of pipe.results) {
    const d = r.decision;
    const label = `Check ${r.n} · ${r.name}`;
    const key = `layer_${r.id}`;
    if (d) stages[key] = d.latency_ms;
    const score = d?.score != null ? ` (${d.score.toFixed(2)})` : '';
    if (d?.error) steps.push({ tone: 'warn', head: `${label} failed`, ms: at(), text: `${d.error}. ${r.action === 'block' ? 'Blocked by its fallback setting.' : r.fellBack && d.raw === '' && d.reason.startsWith('Built-in') ? 'Used the built-in patterns instead.' : 'Its fallback setting decided.'}` });
    if (r.action === 'off') steps.push({ tone: 'neutral', head: r.bypassed ? `${label} is off for ${groupName}` : `${label} is off`, ms: at(), text: r.bypassed ? `${groupName} skips this layer.` : 'This layer is switched off.' });
    else if (r.action === 'nothing') steps.push({ tone: 'ok', head: `${label} · nothing new to scan`, ms: at(), text: 'No new user message or tool result since the model last answered.' });
    else if (r.action === 'pass' || r.action === 'cleared') steps.push({ tone: 'ok', head: `${label}: ${r.type === 'judge' ? 'allow' : 'clean'}${score}`, ms: at(), text: r.action === 'cleared' ? 'It cleared what an earlier layer flagged.' : d?.reason ?? '', why: r.type === 'judge' ? d?.raw || d?.reason : undefined });
    else if (r.action === 'flag') steps.push({ tone: 'warn', head: `${label} flagged it${score}`, ms: at(), text: `${d?.reason ?? ''}. Text that triggered it:`, quote: d?.quote ?? undefined });
    else if (r.action === 'redact') steps.push({ tone: 'warn', head: `${label} redacted ${d?.categories.join(', ')}`, ms: at(), text: 'Matching text was replaced with [REDACTED] before the request went on.' });
    else if (r.action === 'block') steps.push({ tone: 'bad', head: `${label}: block${score}`, ms: at(), text: d?.reason ?? '', why: d?.raw || undefined, quote: d?.quote ?? undefined });
  }
  // The Activity columns still show "check 1" (first scoring layer) and "check 2" (first judge).
  const c1 = pipe.results.find((r) => r.id === 'piguard') ?? pipe.results.find((r) => r.type === 'classifier' || r.type === 'patterns');
  const c2 = pipe.results.find((r) => r.id === 'judge') ?? pipe.results.find((r) => r.type === 'judge');
  log.c1_score = c1?.decision?.score ?? null;
  log.c1_status = !c1 ? 'off' : c1.action === 'off' ? 'off' : c1.action === 'nothing' ? 'skipped' : c1.action === 'flag' || c1.action === 'block' ? 'flagged' : 'clean';
  log.c2_status = !c2 ? 'off' : c2.action === 'off' ? (pipe.unresolved ? 'error' : 'off') : c2.action === 'skipped' || c2.action === 'nothing' ? 'skipped' : c2.action === 'block' ? (c2.decision?.error ? 'error' : 'block') : 'allow';
  log.c2_reason = c2?.decision?.reason ?? null;
  if (pipe.unresolved) steps.push({ tone: pipe.block ? 'bad' : 'warn', head: pipe.block ? 'Flag not cleared: blocked' : 'Flag not cleared: allowed', ms: at(), text: `No later layer judged what was flagged, so the "unresolved flag" setting decided (${settings.guard.unresolvedFlag}).` });
  if (pipe.block) return block(pipe.block.reason, {});
  if (pipe.redact.length) {
    messages = applyRedactions(messages, pipe.redact);
    redacted = true;
    outcome = 'redacted';
  }
  if (pipe.cleared && outcome === 'answered') outcome = 'false_alarm';
  // The suffix check warmed one provider's cache: send the real call there too.
  const warmed = pipe.results.find((x) => x.decision?.suffix && x.decision.provider)?.decision?.provider;
  if (suffixOn && onOpenRouter && warmed) {
    body.provider = { ...(body.provider as object), order: [warmed], allow_fallbacks: true };
    lastProvider.set(stickyKey, warmed);
  }

  // A router layer picked the model. Only a model this key may use; otherwise keep the client's.
  if (pipe.route && pipe.route.model !== model) {
    const to = pipe.route.model;
    const allowed = byModel.get(to);
    if (allowed?.length) {
      steps.push({ tone: 'neutral', head: `Routed to ${to}`, ms: at(), text: `${pipe.route.layer} answered "${pipe.route.label ?? 'no answer'}", so the request goes to ${to} instead of ${model}.` });
      model = to;
      routes = allowed;
      log.model = to;
      body.model = to;
    } else steps.push({ tone: 'warn', head: `Router picked ${to}, kept ${model}`, ms: at(), text: `${pipe.route.layer} picked ${to}, but this key's group may not use it, so the request stays on ${model}.` });
  }

  if (early?.active) early.status('Request approved. Asking the model…', 'waiting for the model');
  // 6. Project context
  lap();
  trace.context = files.map((f) => ({ name: f.name, tokens: estimateTokens(f.body) }));
  trace.contextTokens = ctx ? estimateTokens(ctx) : 0;
  trace.placement = settings.contextPlacement;
  log.injected = ctx ? { files: trace.context, policy: !!settings.policyPrompt.trim(), tokens: trace.contextTokens, placement: settings.contextPlacement, ...(identity ? { identity } : {}) } : null;
  if (ctx) {
    if (kind === 'chat') body.messages = forwardMessages(messages);
    else body.prompt = `${ctx}\n\n${contentText(messages[0].content)}`;
    steps.push({ tone: 'neutral', head: 'Context added', ms: at(), text: `${[identity && 'caller identity', ...files.map((f) => f.name), settings.policyPrompt.trim() && 'policy prompt'].filter(Boolean).join(', ')} · ${estimateTokens(ctx).toLocaleString()} tokens, ${settings.contextPlacement === 'top' ? 'at the top (cacheable)' : 'before the last message'}` });
  } else {
    // Nothing selected: the request goes on exactly as the client sent it (after any redaction).
    if (kind === 'chat') body.messages = forwardMessages(messages);
    else if (redacted) body.prompt = contentText(messages[0].content);
    steps.push({ tone: 'neutral', head: 'No context added', ms: at(), text: `${groupName} has no context files, the policy prompt is empty and this key doesn't send its caller identity, so nothing was added to the request.` });
  }
  stages.context = lap();
  trace.forwarded = body;
  log.forwarded = promptForLog(kind === 'chat' ? body.messages : promptMessages(body.prompt));

  // 7b. After-the-model layers: the answer is checked before the client sees any of it. A rejected
  // answer can go back to the model with the reason as feedback (the conversation stays a prefix,
  // so the provider cache is reused), up to the layer's retries; then it is blocked or let through.
  if (outLayers.length) {
    // For a streaming client the model is streamed internally: its thinking (reasoning) is passed on to the client
    // right away, because it is never executed. The answer text and tool calls are held until the checks pass.
    let live: ((text: string) => void) | null = early?.active ? (t) => early.think(t) : null;
    let roleSent = !!early?.active;
    const callOnce = async (b: Record<string, unknown>): Promise<Record<string, unknown> | Response> => {
      for (const r of routes) {
        const t0 = at();
        let up: Response;
        try {
          up = await fetch(`${r.server.url}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(r.server.api_key ? { Authorization: `Bearer ${r.server.api_key}` } : {}) }, body: JSON.stringify(live ? { ...b, stream: true, stream_options: { include_usage: true } } : nonStreaming(b)), signal: req.signal });
        } catch (e) {
          markDown(r.server.id, e);
          steps.push({ tone: 'warn', head: `${r.server.name} unreachable`, ms: at(), text: errMsg(e) });
          continue;
        }
        log.server = r.server.name;
        stages.upstream = (stages.upstream ?? 0) + (at() - t0);
        if (!up.ok) {
          const text = await up.text();
          steps.push({ tone: 'bad', head: `${r.server.name} returned ${up.status}`, ms: at(), text: text.slice(0, 500) });
          finish('error', up.status, `Backend error ${up.status}`, { response: { message: { role: 'assistant', content: '' }, error: text.slice(0, 4000) } });
          return new Response(text, { status: up.status, headers: { 'Content-Type': up.headers.get('content-type') ?? 'application/json', 'x-guardrail-request-id': id, 'x-opsara-request-id': id } });
        }
        let json: Record<string, unknown>;
        if (live && up.body) {
          const collect = new StreamCollector();
          collect.onReasoning = live;
          const reader = up.body.getReader();
          const dec = new TextDecoder();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              collect.push(dec.decode(value, { stream: true }));
            }
          } catch (e) {
            markDown(r.server.id, e);
            steps.push({ tone: 'warn', head: `${r.server.name} stream broke`, ms: at(), text: errMsg(e) });
            continue;
          }
          const got = collect.result();
          const { reasoning, ...message } = got.message as typeof got.message & { reasoning?: string };
          json = { id: `chatcmpl-${id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { ...message, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: got.finish_reason }], ...(got.usage ? { usage: got.usage } : {}), ...(collect.provider ? { provider: collect.provider } : {}) };
        } else json = (await up.json()) as Record<string, unknown>;
        if (typeof json.provider === 'string') lastProvider.set(`${r.server.id}::${model}`, json.provider);
        return json;
      }
      const msg = `No server for ${model} is reachable right now.`;
      finish('error', 502, msg);
      return apiError(502, msg, 'api_error', id, 'backend_unavailable');
    };
    const produce = async (): Promise<Response> => {
      let msgs = body.messages as Msg[];
      const outResults: LayerResult[] = [];
      let retryNote = '';
      for (let attempt = 1; ; attempt++) {
        if (early?.cancelled) {
          finish('error', 499, 'Client went away');
          return new Response(null, { status: 499 });
        }
        if (attempt > 1) early?.status('', 'asking the model again');
        emit?.({ type: 'model', attempt, model });
        if (attempt > 1 && live) live(`\n\n[Security check: the previous answer was rejected (${retryNote}). Asking the model again.]\n\n`);
        const json = await callOnce({ ...body, messages: msgs });
        if (json instanceof Response) return json;
        // Retries go to the provider that just answered, whose cache now holds this conversation.
        if (onOpenRouter && typeof json.provider === 'string') body.provider = { ...(body.provider as object), order: [json.provider], allow_fallbacks: true };
        const resp = responseFromJson(json);
        const usage = json.usage as { cost?: number } | undefined;
        emit?.({ type: 'draft', attempt, text: typeof resp.message.content === 'string' ? resp.message.content : '', toolCalls: resp.message.tool_calls?.length ?? 0, cache: cacheOf(json), cost: typeof usage?.cost === 'number' ? usage.cost : null });
        const text = typeof resp.message.content === 'string' ? resp.message.content : JSON.stringify(resp.message.content ?? '');
        const calls = resp.message.tool_calls ?? [];
        const segs: Segment[] = [...(text.trim() ? [{ source: 'model answer' as const, text }] : []), ...calls.map((c) => ({ source: 'tool call' as const, text: `${c.function?.name ?? 'tool'}(${c.function?.arguments ?? ''})` }))];
        if (early?.cancelled) {
          finish('error', 499, 'Client went away');
          return new Response(null, { status: 499 });
        }
        early?.status('\nChecking the answer…', `checking answer #${attempt}`);
        const check = await runPipeline({
          segments: segs,
          layers: outLayers,
          resolution: res,
          escalate: null,
          unresolvedFlag: 'allow',
          serverOf: (sid) => getServer(sid),
          metaOf: modelMeta,
          conversation: { body: { ...body, messages: [...msgs, resp.message] }, model, serverId: routes[0].server.id },
          onLayer: emit ? (e) => emit({ type: 'layer', ...e, stage: 'output', attempt }) : undefined,
        });
        outResults.push(...check.results.map((x) => ({ ...x, stage: 'output' as const, attempt })));
        log.decisions = [...pipe.results, ...outResults];
        const flagged = check.results.filter((x) => x.action === 'flag');
        if (!check.block) {
          steps.push({ tone: flagged.length ? 'warn' : 'ok', head: `Answer #${attempt} checked: ${flagged.length ? `flagged by ${flagged.map((x) => x.name).join(', ')}` : 'passed'}`, ms: at(), text: `${outLayers.length} after-the-model layer(s) checked it before the client saw it.` });
          finish(outcome, 200, null, { tokens_out: (json.usage as { completion_tokens?: number } | undefined)?.completion_tokens ?? null, response: resp });
          return stream ? sseFromJson(json, { requestId: id, kind: 'chat', roleSent }) : Response.json(json, { headers: { 'x-guardrail-request-id': id, 'x-opsara-request-id': id, 'x-guardrail-checked': '1' } });
        }
        const layer = outLayers.find((l) => l.name === check.block!.layer);
        const d = check.results.find((x) => x.action === 'block')?.decision;
        steps.push({ tone: 'warn', head: `Answer #${attempt} rejected by ${check.block.layer}`, ms: at(), text: check.block.reason, quote: (text || calls.map((c) => `${c.function?.name}(${c.function?.arguments ?? ''})`).join('\n')).slice(0, 600) });
        if (layer?.onFail === 'retry' && attempt <= (layer.retries ?? 2)) {
          const feedback = (layer.retryPrompt || RETRY_PROMPT)
            .replace(/\{reason\}/g, check.block.reason.replace(/[.\s]+$/, ''))
            .replace(/\{categories\}/g, d?.categories.join(', ') || 'none')
            .replace(/\{verdict\}/g, d?.verdict ?? 'block');
          retryNote = check.block.reason.replace(/[.\s]+$/, '');
          msgs = [...msgs, resp.message as Msg, { role: 'user', content: feedback }];
          steps.push({ tone: 'neutral', head: `Asked the model to fix it (retry ${attempt} of ${layer.retries ?? 2})`, ms: at(), text: feedback });
          continue;
        }
        if (layer?.onFail === 'retry' && layer.onExhausted === 'flag') {
          steps.push({ tone: 'warn', head: 'Retries used up: answer let through, flagged', ms: at(), text: check.block.reason });
          finish('false_alarm', 200, check.block.reason, { tokens_out: (json.usage as { completion_tokens?: number } | undefined)?.completion_tokens ?? null, response: resp });
          return stream ? sseFromJson(json, { requestId: id, kind: 'chat', roleSent }) : Response.json(json, { headers: { 'x-guardrail-request-id': id, 'x-opsara-request-id': id } });
        }
        return block(layer?.onFail === 'retry' ? `${check.block.reason} (still failing after ${layer.retries ?? 2} retries)` : check.block.reason, {});
      }
    };
    if (!stream || early?.active) return produce();
    // Streaming clients wait for the checked answer; keep-alive comments keep the connection open.
    const enc = new TextEncoder();
    const out = new ReadableStream<Uint8Array>({
      async start(c) {
        const t = setInterval(() => c.enqueue(enc.encode(': checking the answer\n\n')), 5000);
        const created = Math.floor(Date.now() / 1000);
        live = (text) => {
          const chunk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ id: `chatcmpl-${id}`, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
          if (!roleSent) {
            roleSent = true;
            c.enqueue(enc.encode(chunk({ role: 'assistant', content: '' })));
          }
          c.enqueue(enc.encode(chunk({ reasoning_content: text })));
        };
        try {
          const r = await produce();
          clearInterval(t);
          if (r.body) {
            const reader = r.body.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              c.enqueue(value);
            }
          }
        } catch (e) {
          c.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: errMsg(e) } })}\n\n`));
        } finally {
          clearInterval(t);
          c.close();
        }
      },
    });
    return new Response(out, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'x-guardrail-request-id': id, 'x-opsara-request-id': id } });
  }

  emit?.({ type: 'model', attempt: 1, model });
  // 7. Forward to vLLM, failing over between servers
  for (const r of routes) {
    const tStart = at();
    let up: Response;
    try {
      up = await fetch(`${r.server.url}/v1/${kind === 'chat' ? 'chat/completions' : 'completions'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(r.server.api_key ? { Authorization: `Bearer ${r.server.api_key}` } : {}) },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      if (req.signal.aborted) {
        finish('error', 499, 'Client went away');
        return new Response(null, { status: 499 });
      }
      markDown(r.server.id, e);
      steps.push({ tone: 'warn', head: `${r.server.name} unreachable`, ms: at(), text: errMsg(e) });
      continue;
    }
    log.server = r.server.name;
    if (!up.ok) {
      const text = await up.text();
      steps.push({ tone: 'bad', head: `${r.server.name} returned ${up.status}`, ms: at(), text: text.slice(0, 500) });
      finish('error', up.status, `Backend error ${up.status}`, { response: { message: { role: 'assistant', content: '' }, error: text.slice(0, 4000) } });
      return new Response(text, { status: up.status, headers: { 'Content-Type': up.headers.get('content-type') ?? 'application/json', 'x-guardrail-request-id': id, 'x-opsara-request-id': id } });
    }
    const label = outcome === 'false_alarm' ? 'Sent to the model (false alarm logged)' : 'Sent to the model';
    if (!stream || !up.body) {
      const json = (await up.json()) as { usage?: { completion_tokens?: number } };
      stages.upstream = at() - tStart;
      steps.push({ tone: 'ok', head: `${label} · ${r.server.name}, answered`, ms: at(), text: `${json.usage?.completion_tokens ?? '?'} tokens.` });
      if (typeof (json as { provider?: unknown }).provider === 'string') lastProvider.set(`${r.server.id}::${model}`, (json as unknown as { provider: string }).provider);
      finish(outcome, 200, null, { tokens_out: json.usage?.completion_tokens ?? null, response: responseFromJson(json) });
      return Response.json(json, { headers: { 'x-guardrail-request-id': id, 'x-opsara-request-id': id } });
    }
    // Stream straight through; count chunks as we go and finish the log at the end.
    finish(outcome, 200, null);
    let chunks = 0;
    let usage: number | null = null;
    let done = false;
    const dec = new TextDecoder();
    let tail = '';
    const reader = up.body.getReader();
    // Rebuild the reply for the log as it streams by; the client gets every byte unchanged and undelayed.
    const collect = new StreamCollector();
    const close = (how: string, interrupted = false) => {
      if (done) return;
      done = true;
      stages.upstream = at() - tStart;
      steps.push({ tone: interrupted ? 'warn' : 'ok', head: `${label} · ${r.server.name}, ${how}`, ms: at(), text: `Streamed ${usage ?? chunks} ${usage ? 'tokens' : 'chunks'}.` });
      if (collect.provider) lastProvider.set(`${r.server.id}::${model}`, collect.provider);
      updateLog(id, { latency_ms: Math.round(at()), tokens_out: usage ?? chunks, stages, steps, response: collect.result({ interrupted }) });
    };
    const out = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const { value, done: end } = await reader.read();
          if (end) {
            close('answered');
            c.close();
            return;
          }
          const text = dec.decode(value, { stream: true });
          collect.push(text);
          const lines = (tail + text).split('\n');
          tail = lines.pop() ?? '';
          for (const l of lines) {
            if (!l.startsWith('data:') || l.includes('[DONE]')) continue;
            chunks++;
            const m = l.match(/"completion_tokens"\s*:\s*(\d+)/);
            if (m) usage = Number(m[1]);
          }
          c.enqueue(value);
        } catch (e) {
          close(`stream broke (${errMsg(e)})`, true);
          c.error(e);
        }
      },
      cancel(reason) {
        close('client stopped reading', true);
        return reader.cancel(reason);
      },
    });
    return new Response(out, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'x-guardrail-request-id': id, 'x-opsara-request-id': id },
    });
  }
  const msg = `No server for ${model} is reachable right now.`;
  steps.push({ tone: 'bad', head: 'All servers failed', ms: at(), text: msg });
  finish('error', 502, msg);
  return apiError(502, msg, 'api_error', id, 'backend_unavailable');
}

export function handleModels(req: Request): Response {
  const id = newRequestId();
  const found = lookupKey(bearer(req));
  if (!found.ok) return apiError(401, found.reason, 'authentication_error', id, 'invalid_api_key');
  if (!ipAllowed(clientIp(req), found.key.ipAllow)) return apiError(403, `This key can only be used from ${found.key.ipAllow.join(', ')}.`, 'permission_error', id, 'ip_not_allowed');
  const eff = resolveGroup(found.key.groupId, found.key.exceptions).effective;
  const { byModel } = allowedRoutes(found.key, eff);
  const ctxRows = new Map(
    (getDb().prepare('SELECT name, MAX(context_len) c FROM models GROUP BY name').all() as { name: string; c: number | null }[]).map((r) => [r.name, r.c]),
  );
  return Response.json({
    object: 'list',
    data: [...byModel.keys()].sort().map((m) => ({ id: m, object: 'model', created: 0, owned_by: 'guardrail', max_model_len: ctxRows.get(m) ?? undefined })),
  });
}
