import { buildContextBlock, estimateTokens, filesByIds } from './context';
import { contentText, newSegments, renderBlocked, runCheck1, runCheck2, Segment } from './guard';
import { chainOf, groupPath, listGroups, resolveGroup, Effective } from './groups';
import { ApiKey, checkKey, lookupKey, touchKey } from './keys';
import { groupAllowed, limitsFor, listLimits, takeToken } from './limits';
import { LogEntry, Outcome, Step, newRequestId, promptForLog, updateLog, writeLog } from './logs';
import { countHit, matchRules, redactMessages } from './rules';
import { detectSchema, schemaForPath } from './schemas';
import { getDb } from './db';
import { errMsg, listModelsForRouting, markDown, Server } from './servers';
import { getSettings } from './settings';
import { apiError, blockedResponse } from './sse';

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
  /** Shown as the client address in the log. */
  source?: string;
}

export function clientIp(req: Request): string | null {
  const xf = req.headers.get('x-forwarded-for');
  if (xf) return xf.split(',')[0].trim();
  return req.headers.get('x-real-ip');
}

export function bearer(req: Request): string | null {
  const a = req.headers.get('authorization');
  if (a?.toLowerCase().startsWith('bearer ')) return a.slice(7).trim() || null;
  return req.headers.get('x-api-key')?.trim() || null;
}

/** Put the context block where vLLM can cache it: the very start of the prompt. */
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

export async function handleCompletion(req: Request, kind: Kind, opts: GatewayOptions = {}): Promise<Response> {
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
  const stages: Record<string, number> = {};
  const log: Partial<LogEntry> & { id: string; ts: number } = { id, ts: Date.now(), ip: opts.source ?? clientIp(req), path };

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
  const model = String(body.model ?? '');
  log.model = model || null;
  const { byModel } = allowedRoutes(key, eff);
  const routes = byModel.get(model);
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
    finish('blocked', 200, reason, extra);
    return blockedResponse({ stream, model, text, requestId: id, kind });
  };

  stages.access = lap();

  // 4. Custom rules
  const hits = matchRules(segments, chainOf(key.groupId, groups).map((g) => g.id));
  stages.rules = lap();
  let escalate = false;
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
    escalate = true;
    steps.push({ tone: 'warn', head: `Rule "${escHit.rule.name}" sent it to check 2`, ms: at(), text: `Matched in a ${escHit.source}:`, quote: escHit.match });
  }

  // 5. The two guard checks. Each can be off on its own: with PIGuard off,
  // check 2 judges every request; with both off, requests go straight on.
  let outcome: Outcome = redacted ? 'redacted' : 'answered';
  // The Guard checks page sets the default for everyone; a group (and so every key in it) can turn either
  // check off, or on again under a group that turned it off. `eff` already holds the resolved answer.
  const g = settings.guard;
  const c1On = g.enabled && eff.piguard_enabled;
  const c2On = g.enabled && eff.oss_enabled;
  const groupName = groups.find((x) => x.id === key.groupId)?.name ?? 'this group';
  const c1Bypass = g.enabled && g.piguard.enabled && !eff.piguard_enabled; // on for the app, off for this group
  const c2Bypass = g.enabled && g.oss.enabled && !eff.oss_enabled;
  const gc2 = { ...g, oss: { ...g.oss, enabled: c2On } }; // what check 2 sees: on or off for THIS group
  const judge = settings.guard.oss.model.split('/').pop();
  let toCheck2 = false;
  let c1Flagged = false;
  let c1Quote: string | null = null;
  if (c1On) {
    const c1 = await runCheck1(segments, g);
    stages.piguard = c1.ms;
    log.c1_score = c1.score;
    c1Flagged = c1.score >= eff.piguard_threshold;
    c1Quote = c1.quote;
    toCheck2 = c1Flagged || escalate;
    log.c1_status = !segments.length ? 'skipped' : c1Flagged ? 'flagged' : 'clean';
    if (c1.error) steps.push({ tone: 'warn', head: 'Check 1 fell back to built-in patterns', ms: at(), text: c1.error });
    if (!segments.length) steps.push({ tone: 'ok', head: 'Check 1 · nothing new to scan', ms: at(), text: 'No new user message or tool result since the model last answered.' });
    else if (c1Flagged)
      steps.push({ tone: 'warn', head: `Check 1 · PIGuard flagged it (${c1.score.toFixed(2)})`, ms: at(), text: `Score is at or above the limit of ${eff.piguard_threshold.toFixed(2)} (${c1.engine}). Text that triggered it, from a ${c1.source}:`, quote: c1.quote ?? undefined });
    else steps.push({ tone: 'ok', head: `Check 1 · PIGuard: clean (${c1.score.toFixed(2)})`, ms: at(), text: `Below the limit of ${eff.piguard_threshold.toFixed(2)}, so check 2 was skipped.` });
  } else {
    log.c1_status = 'off';
    // Nothing new means nothing for the judge to read either.
    toCheck2 = c2On && segments.length > 0;
    steps.push({
      tone: 'neutral',
      head: c1Bypass ? `Check 1 · PIGuard is off for ${groupName}` : 'Check 1 · PIGuard is off',
      ms: at(),
      text: !c2On ? 'Check 2 is off too, so no guard check ran.' : toCheck2 ? `Sent straight to check 2 (${judge}).` : 'Nothing new to scan, so check 2 was skipped.',
    });
  }

  if (c2Bypass && c1On)
    steps.push({ tone: 'neutral', head: `Check 2 · off for ${groupName}`, ms: at(), text: toCheck2 ? 'This group skips the second check, so the "if it fails or times out" setting decides what happens to a flagged request.' : 'This group skips the second check.' });
  if (toCheck2) {
    const c2 = await runCheck2(segments, c1Quote ?? escHit?.match ?? null, eff.oss_prompt, gc2);
    stages.oss = c2.ms;
    log.c2_status = c2.error ? (c2.verdict === 'block' ? 'error' : 'allow') : c2.verdict;
    log.c2_reason = c2.reason;
    if (c2.verdict === 'block') {
      steps.push({ tone: 'bad', head: `Check 2 · ${judge}: block`, ms: at(), text: c2.error ? `It could not decide: ${c2.error}.` : 'Its reasoning:', why: c2.reasoning ? `${c2.reason}\n\n${c2.reasoning}` : c2.reason });
      return block(c2.reason, {});
    }
    steps.push({ tone: 'ok', head: `Check 2 · ${judge}: allow`, ms: at(), text: c2.error ? `It could not decide (${c2.error}); allowed by setting.` : 'Its reasoning:', why: c2.reasoning ? `${c2.reason}\n\n${c2.reasoning}` : c2.reason });
    if (c1Flagged) outcome = 'false_alarm';
  } else log.c2_status = c2On ? 'skipped' : 'off';

  // 6. Project context
  lap();
  const files = filesByIds(eff.context);
  const ctx = buildContextBlock(settings.policyPrompt, files);
  trace.context = files.map((f) => ({ name: f.name, tokens: estimateTokens(f.body) }));
  trace.contextTokens = ctx ? estimateTokens(ctx) : 0;
  trace.placement = settings.contextPlacement;
  if (ctx) {
    if (kind === 'chat') body.messages = injectContext(messages, ctx, settings.contextPlacement);
    else body.prompt = `${ctx}\n\n${contentText(messages[0].content)}`;
    steps.push({ tone: 'neutral', head: 'Context added', ms: at(), text: `${files.map((f) => f.name).join(', ') || 'Policy prompt'} · ${estimateTokens(ctx).toLocaleString()} tokens, ${settings.contextPlacement === 'top' ? 'at the top (cacheable)' : 'before the last message'}` });
  } else if (kind === 'chat') body.messages = messages;
  else body.prompt = contentText(messages[0].content);
  stages.context = lap();
  trace.forwarded = body;
  log.forwarded = promptForLog(kind === 'chat' ? body.messages : promptMessages(body.prompt));

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
      finish('error', up.status, `Backend error ${up.status}`);
      return new Response(text, { status: up.status, headers: { 'Content-Type': up.headers.get('content-type') ?? 'application/json', 'x-guardrail-request-id': id } });
    }
    const label = outcome === 'false_alarm' ? 'Sent to the model (false alarm logged)' : 'Sent to the model';
    if (!stream || !up.body) {
      const json = (await up.json()) as { usage?: { completion_tokens?: number } };
      stages.upstream = at() - tStart;
      steps.push({ tone: 'ok', head: `${label} · ${r.server.name}, answered`, ms: at(), text: `${json.usage?.completion_tokens ?? '?'} tokens.` });
      finish(outcome, 200, null, { tokens_out: json.usage?.completion_tokens ?? null });
      return Response.json(json, { headers: { 'x-guardrail-request-id': id } });
    }
    // Stream straight through; count chunks as we go and finish the log at the end.
    finish(outcome, 200, null);
    let chunks = 0;
    let usage: number | null = null;
    let done = false;
    const dec = new TextDecoder();
    let tail = '';
    const reader = up.body.getReader();
    const close = (how: string) => {
      if (done) return;
      done = true;
      stages.upstream = at() - tStart;
      steps.push({ tone: 'ok', head: `${label} · ${r.server.name}, ${how}`, ms: at(), text: `Streamed ${usage ?? chunks} ${usage ? 'tokens' : 'chunks'}.` });
      updateLog(id, { latency_ms: Math.round(at()), tokens_out: usage ?? chunks, stages, steps });
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
          const lines = (tail + dec.decode(value, { stream: true })).split('\n');
          tail = lines.pop() ?? '';
          for (const l of lines) {
            if (!l.startsWith('data:') || l.includes('[DONE]')) continue;
            chunks++;
            const m = l.match(/"completion_tokens"\s*:\s*(\d+)/);
            if (m) usage = Number(m[1]);
          }
          c.enqueue(value);
        } catch (e) {
          close(`stream broke (${errMsg(e)})`);
          c.error(e);
        }
      },
      cancel(reason) {
        close('client stopped reading');
        return reader.cancel(reason);
      },
    });
    return new Response(out, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'x-guardrail-request-id': id },
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
