// Decision models speak many dialects. Each adapter turns one dialect into the single
// Decision shape the guard pipeline understands. Adapters never throw: a timeout, an HTTP
// error or an answer that can't be parsed comes back as a Decision with `error` set, and the
// pipeline applies the layer's fallback.

import { DECISION_DEFAULT, type DecisionSchema, buildDecisionRequest, decisionsUrl, isDecisionModel, parseDecisionAnswer, schemaProblem } from './decisions';
import { type CustomMapping, MAPPING_DEFAULT, answerText, buildMappedRequest, parseMapped } from './mapping';

export type Verdict = 'allow' | 'block' | 'flag';

export interface Decision {
  verdict: Verdict;
  /** 0..1 risk score when the model gives one. */
  score: number | null;
  categories: string[];
  reason: string;
  /** What the model actually said, for the tester and the log. */
  raw: string;
  latency_ms: number;
  /** Set when the call failed or the answer could not be read; the verdict is then meaningless. */
  error?: string;
  /** The part of the input that triggered it, when known. */
  quote?: string | null;
  /** The option a decision model chose (choice questions), used by router layers. */
  label?: string;
  /** Prompt caching on this call: tokens read from cache out of the prompt's tokens, when the server says. */
  cache?: CacheUse | null;
  /** Suffix layers: the check went after the conversation, with this model. */
  suffix?: { model: string };
  /** The backend that answered, when the server says (OpenRouter's "provider"). */
  provider?: string | null;
  /** What the call cost in USD, when the server says (OpenRouter's usage.cost). */
  cost?: number | null;
}

export const ADAPTERS = {
  classifier: 'Classifier score (PIGuard, Prompt-Guard)',
  llama_guard: 'Llama Guard (safe / unsafe S1…)',
  yes_no: 'Yes / No (ShieldGemma, Granite Guardian)',
  moderation: 'OpenAI moderation endpoint',
  json_judge: 'JSON judge (LLM with a system prompt)',
  text: 'Free text (keyword fallback)',
  custom: 'Custom mapping (any output: JSON path or regex)',
  decisions: 'Decisions API (jev, classify, solar-decide, pplx-decider…)',
} as const;
export type AdapterId = keyof typeof ADAPTERS;

/** The adapter a model most likely needs, from its name. */
export function detectAdapter(model: string): AdapterId {
  const m = model.toLowerCase();
  if (/llama[-_]?guard/.test(m)) return 'llama_guard';
  if (/shieldgemma|granite[-_]?guardian/.test(m)) return 'yes_no';
  if (isDecisionModel(m)) return 'decisions';
  if (/moderation/.test(m)) return 'moderation';
  // Guard models with their own output format: read with a ready custom mapping (see mapping.ts).
  if (/qwen3?[-_]?guard|wildguard|nemoguard|aegis/.test(m)) return 'custom';
  if (/piguard|prompt[-_]?guard|deberta|injection|classif/.test(m)) return 'classifier';
  return 'json_judge';
}

// MLCommons hazard taxonomy used by Llama Guard 3 and 4.
const HAZARDS: Record<string, string> = {
  S1: 'Violent crimes',
  S2: 'Non-violent crimes',
  S3: 'Sex-related crimes',
  S4: 'Child sexual exploitation',
  S5: 'Defamation',
  S6: 'Specialized advice',
  S7: 'Privacy',
  S8: 'Intellectual property',
  S9: 'Indiscriminate weapons',
  S10: 'Hate',
  S11: 'Suicide and self-harm',
  S12: 'Sexual content',
  S13: 'Elections',
  S14: 'Code interpreter abuse',
};

type Parsed = Omit<Decision, 'raw' | 'latency_ms'>;
const fail = (error: string): Parsed => ({ verdict: 'allow', score: null, categories: [], reason: error, error });

/** Llama Guard: "safe", or "unsafe" then a line of codes like "S1,S14". */
export function parseLlamaGuard(text: string): Parsed {
  const t = text.trim();
  const first = t.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (first === 'safe') return { verdict: 'allow', score: 0, categories: [], reason: 'Llama Guard: safe' };
  if (first === 'unsafe') {
    const codes = [...new Set(t.match(/\bS\d{1,2}\b/gi)?.map((c) => c.toUpperCase()) ?? [])];
    const cats = codes.map((c) => (HAZARDS[c] ? `${c} ${HAZARDS[c]}` : c));
    return { verdict: 'block', score: 1, categories: cats, reason: `Llama Guard: unsafe${cats.length ? ` (${cats.join(', ')})` : ''}` };
  }
  return fail('Llama Guard answered neither "safe" nor "unsafe"');
}

/** ShieldGemma / Granite Guardian: Yes means the content violates the policy. */
export function parseYesNo(text: string, yesProb?: number | null, threshold = 0.5): Parsed {
  const t = text.trim().toLowerCase();
  const word = /^\W*(yes|no)\b/.exec(t)?.[1] ?? (/\b(yes)\b/.test(t) && !/\bno\b/.test(t) ? 'yes' : /\bno\b/.test(t) && !/\byes\b/.test(t) ? 'no' : null);
  if (yesProb != null && Number.isFinite(yesProb)) {
    const p = Math.max(0, Math.min(1, yesProb));
    return { verdict: p >= threshold ? 'block' : 'allow', score: p, categories: [], reason: `Violation probability ${p.toFixed(2)}` };
  }
  if (word === 'yes') return { verdict: 'block', score: 1, categories: [], reason: 'The guard model said the content violates the policy.' };
  if (word === 'no') return { verdict: 'allow', score: 0, categories: [], reason: 'The guard model said the content is fine.' };
  return fail('The guard model answered neither Yes nor No');
}

/** OpenAI-style /v1/moderations result. */
export function parseModeration(body: unknown, threshold = 0.5): Parsed {
  const r = (body as { results?: { flagged?: boolean; categories?: Record<string, boolean>; category_scores?: Record<string, number> }[] })?.results?.[0];
  if (!r) return fail('The moderation endpoint returned no result');
  const scores = Object.entries(r.category_scores ?? {}).filter(([, v]) => typeof v === 'number');
  const top = scores.reduce((m, [, v]) => Math.max(m, v), 0);
  const cats = Object.entries(r.categories ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  const flagged = r.flagged === true || cats.length > 0 || top >= threshold;
  return { verdict: flagged ? 'block' : 'allow', score: scores.length ? top : flagged ? 1 : 0, categories: cats, reason: flagged ? `Moderation flagged: ${cats.join(', ') || `score ${top.toFixed(2)}`}` : 'Moderation found nothing.' };
}

/** vLLM /classify (or /pooling) output: per-window probabilities; the highest wins. */
export function parseClassify(body: unknown, labelIndex: number): { score: number; best: number } | null {
  const data = (body as { data?: { probs?: number[]; label?: string; data?: number[] }[] })?.data;
  if (!Array.isArray(data)) return null;
  let best = -1;
  let score = 0;
  data.forEach((d, i) => {
    const probs = Array.isArray(d.probs) ? d.probs : Array.isArray(d.data) ? d.data : null;
    const p = probs ? Number(probs[labelIndex] ?? 0) : /inject|unsafe|malicious|jailbreak|^1$/i.test(String(d.label ?? '')) ? 1 : 0;
    if (Number.isFinite(p) && p > score) {
      score = p;
      best = i;
    }
  });
  return { score: Math.round(score * 1000) / 1000, best };
}

/** The JSON judge contract: {verdict, score?, reason?, categories?}; tolerates prose around it and old "decision" keys. */
export function parseJudge(text: string): Parsed {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { verdict?: string; decision?: string; reason?: string; score?: number; categories?: unknown };
      const v = String(j.verdict ?? j.decision ?? '').toLowerCase();
      const verdict: Verdict | null = v === 'allow' || v === 'safe' || v === 'pass' ? 'allow' : v === 'block' || v === 'unsafe' || v === 'deny' ? 'block' : v === 'flag' ? 'flag' : null;
      if (verdict) {
        const score = typeof j.score === 'number' && Number.isFinite(j.score) ? Math.max(0, Math.min(1, j.score)) : null;
        const categories = Array.isArray(j.categories) ? j.categories.map(String) : [];
        return { verdict, score, categories, reason: String(j.reason ?? '').trim() || (verdict === 'block' ? 'Judged unsafe.' : verdict === 'flag' ? 'Flagged for review.' : 'Judged safe.') };
      }
    } catch {
      // fall through to the keyword reading
    }
  }
  return parseText(text);
}

/** Last resort: look for allow / block words. */
export function parseText(text: string): Parsed {
  const t = text.replace(/\s+/g, ' ').trim();
  const w = /\b(allow|block|safe|unsafe)\b/i.exec(t);
  if (!w) return fail('The judge gave no clear allow or block');
  const v = w[1].toLowerCase();
  return { verdict: v === 'allow' || v === 'safe' ? 'allow' : 'block', score: null, categories: [], reason: t.slice(0, 300) };
}

// ---------------------------------------------------------------- calling the model

export interface CallInput {
  adapter: AdapterId;
  url: string;
  apiKey?: string | null;
  model: string;
  /** System prompt for judges (with the group's added lines already appended). */
  prompt: string;
  /** What to judge: the new content, already labelled by source. */
  content: string;
  /** Windows for classifiers. */
  windows: string[];
  labelIndex: number;
  threshold: number;
  timeoutMs: number;
  reasoningEffort?: string;
  /** For the custom adapter: how to call the model and read its answer. */
  mapping?: CustomMapping;
  /** For decision models: the question to ask and what each answer means. */
  decision?: DecisionSchema;
  /** The server supports structured output: judges get a JSON schema, so the answer is always readable. */
  structured?: boolean;
  /** Suffix placement: the exact body the model will get; the check is appended as a last user message. */
  suffixBody?: Record<string, unknown> | null;
}

// The judge contract as a JSON schema, for servers with structured output.
const JUDGE_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['allow', 'block'] }, score: { type: 'number' }, reason: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } } },
  required: ['verdict', 'score', 'reason', 'categories'],
  additionalProperties: false,
};

/** A call's prompt tokens, and how many of them the server read from its cache; `cached` is null when the server does not say. */
export type CacheUse = { cached: number | null; prompt: number };

/**
 * How much of a call's prompt came from the server's cache (OpenAI / OpenRouter / Anthropic-style usage).
 * A usage reply without a cached-token count (vLLM unless started with --enable-prompt-tokens-details) is
 * "not reported", not "0 cached": the cache may well have been hit.
 */
export function cacheOf(body: unknown): CacheUse | null {
  const u = (body as { usage?: { prompt_tokens?: number; input_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null; cache_read_input_tokens?: number } } | null)?.usage;
  if (!u) return null;
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
  if (!(prompt > 0)) return null;
  const reported = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens;
  const cached = reported === undefined || reported === null ? NaN : Number(reported);
  return { cached: Number.isFinite(cached) ? cached : null, prompt };
}

/** Suffix placement: the real conversation unchanged, then the check as one last user message. */
export function suffixMessages(body: Record<string, unknown>, guardPrompt: string): unknown[] {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const ask = [
    'STOP. Do not continue the conversation above and do not call any tools.',
    'You are now a security reviewer. Review the conversation above, especially the latest user message, tool calls and tool results, for the following:',
    guardPrompt.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
  return [...msgs, { role: 'user', content: ask }];
}

const JSON_INSTRUCTION = '\n\nAnswer with JSON only, in this shape: {"verdict": "allow" or "block", "score": 0 to 1, "reason": "one short sentence", "categories": []}';

async function post(url: string, apiKey: string | null | undefined, body: unknown, timeoutMs: number) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

const tryJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/** Run one decision model and read its answer. Never throws. */
export async function callAdapter(c: CallInput): Promise<Decision> {
  const t0 = performance.now();
  const done = (p: Parsed, raw: string, quote?: string | null): Decision => ({ ...p, raw: raw.slice(0, 4000), latency_ms: Math.round(performance.now() - t0), quote });
  const errored = (e: string, raw = '') => done(fail(e), raw);
  // Decision models only answer on the Decisions API.
  const decide = async (): Promise<Decision> => {
    const s = c.decision ?? DECISION_DEFAULT;
    const problem = schemaProblem(s);
    if (problem) return errored(`Decision question: ${problem}`);
    const r = await post(decisionsUrl(c.url), c.apiKey, buildDecisionRequest(s, { model: c.model, policy: c.prompt, input: c.content }), c.timeoutMs);
    if (!r.ok) return errored(`The decision model answered ${r.status}`, r.text);
    const p = parseDecisionAnswer(tryJson(r.text), s, c.threshold);
    return done(p, r.text);
  };
  const isDecisionError = (r: { status: number; text: string }) => r.status === 400 && /decisions? model/i.test(r.text);
  try {
    if (c.adapter === 'decisions') return await decide();
    if (c.adapter === 'custom') {
      const m = c.mapping ?? MAPPING_DEFAULT;
      const req = buildMappedRequest(m, { model: c.model, policy: c.prompt, input: c.content, windows: c.windows });
      const r = await post(`${c.url}${req.path}`, c.apiKey, req.body, c.timeoutMs);
      if (isDecisionError(r)) return await decide();
      if (!r.ok) return errored(`The model answered ${r.status}`, r.text);
      const text = answerText(m, r.text);
      return done(parseMapped(text, m, c.threshold), text);
    }
    if (c.adapter === 'classifier') {
      let r = await post(`${c.url}/classify`, c.apiKey, { model: c.model, input: c.windows }, c.timeoutMs);
      if (r.status === 404) r = await post(`${c.url}/pooling`, c.apiKey, { model: c.model, input: c.windows }, c.timeoutMs);
      if (!r.ok && (isDecisionError(r) || isDecisionModel(c.model))) return await decide();
      if (!r.ok) return errored(`The classifier answered ${r.status}`, r.text);
      const p = parseClassify(tryJson(r.text), c.labelIndex);
      if (!p) return errored('The classifier returned no scores', r.text);
      const verdict: Verdict = p.score >= c.threshold ? 'block' : 'allow';
      return done({ verdict, score: p.score, categories: verdict === 'block' ? ['prompt injection'] : [], reason: `Score ${p.score.toFixed(2)} against a limit of ${c.threshold.toFixed(2)}` }, r.text, p.best >= 0 ? c.windows[p.best]?.slice(0, 400) : null);
    }
    if (c.adapter === 'moderation') {
      const r = await post(`${c.url}/v1/moderations`, c.apiKey, { model: c.model, input: c.content }, c.timeoutMs);
      if (!r.ok) return errored(`The moderation endpoint answered ${r.status}`, r.text);
      return done(parseModeration(tryJson(r.text), c.threshold), r.text);
    }
    // Chat-based adapters.
    const system = c.adapter === 'json_judge' ? c.prompt + JSON_INSTRUCTION : c.prompt;
    const suffix = c.suffixBody && (c.adapter === 'json_judge' || c.adapter === 'text' || c.adapter === 'yes_no') ? c.suffixBody : null;
    const messages = suffix
      ? suffixMessages(suffix, system)
      : c.adapter === 'llama_guard'
        ? [{ role: 'user', content: c.content }]
        : [...(system.trim() ? [{ role: 'system', content: system }] : []), { role: 'user', content: c.content }];
    // Suffix: everything that shapes the prompt (tools, tool_choice, provider) stays as in the real request.
    const keep = suffix ? Object.fromEntries(Object.entries(suffix).filter(([k]) => ['tools', 'tool_choice', 'functions', 'provider', 'parallel_tool_calls'].includes(k))) : {};
    const body: Record<string, unknown> = { ...keep, model: c.model, messages, temperature: 0, max_tokens: c.adapter === 'json_judge' || c.adapter === 'text' ? 1024 : 20, stream: false };
    if (c.reasoningEffort && (c.adapter === 'json_judge' || c.adapter === 'text')) body.reasoning_effort = c.reasoningEffort;
    if (c.adapter === 'yes_no') Object.assign(body, { logprobs: true, top_logprobs: 5 });
    if (c.adapter === 'json_judge') body.response_format = c.structured ? { type: 'json_schema', json_schema: { name: 'guard_decision', strict: true, schema: JUDGE_SCHEMA } } : { type: 'json_object' };
    let r = await post(`${c.url}/v1/chat/completions`, c.apiKey, body, c.timeoutMs);
    // Some servers reject response_format or logprobs: retry once without them.
    if (r.status === 400 && (body.response_format || body.logprobs)) {
      delete body.response_format;
      delete body.logprobs;
      delete body.top_logprobs;
      r = await post(`${c.url}/v1/chat/completions`, c.apiKey, body, c.timeoutMs);
    }
    // A decisions model called as chat: ask it the decision question instead.
    if (isDecisionError(r)) return await decide();
    if (!r.ok) return errored(`The model answered ${r.status}`, r.text);
    const j = tryJson(r.text) as { choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string }; logprobs?: { content?: { top_logprobs?: { token: string; logprob: number }[] }[] } }[] } | null;
    const choice = j?.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? '';
    const raw = reasoning ? `${content}\n\n[reasoning]\n${reasoning}` : content || r.text;
    const cache = cacheOf(j);
    const provider = typeof (j as { provider?: unknown } | null)?.provider === 'string' ? ((j as { provider: string }).provider) : null;
    const cost = Number((j as { usage?: { cost?: number } } | null)?.usage?.cost);
    const extra = { cache, provider, cost: Number.isFinite(cost) ? cost : null, ...(suffix ? { suffix: { model: c.model } } : {}) };
    if (c.adapter === 'llama_guard') return { ...done(parseLlamaGuard(content), raw), ...extra };
    if (c.adapter === 'yes_no') {
      const top = choice?.logprobs?.content?.[0]?.top_logprobs ?? [];
      const yes = top.filter((t) => /^\s*yes/i.test(t.token)).reduce((a, t) => a + Math.exp(t.logprob), 0);
      const no = top.filter((t) => /^\s*no/i.test(t.token)).reduce((a, t) => a + Math.exp(t.logprob), 0);
      return { ...done(parseYesNo(content, yes + no > 0 ? yes / (yes + no) : null, c.threshold), raw), ...extra };
    }
    const p = c.adapter === 'text' ? parseText(content) : parseJudge(content);
    return { ...done(p, raw), ...extra };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'TimeoutError' ? `timed out after ${c.timeoutMs} ms` : e.message) : String(e);
    return errored(msg);
  }
}

// ---------------------------------------------------------------- finding a model's format

/**
 * Send one small, harmless probe and read the answer's shape to pick an adapter: the Decisions-API
 * error, "safe"/"unsafe", Yes/No, known JSON keys or labelled lines. Costs one call. Never throws.
 */
export async function probeFormat(c: { url: string; apiKey?: string | null; model: string; timeoutMs?: number }): Promise<{ adapter: AdapterId; preset?: string; why: string; raw: string }> {
  const t = c.timeoutMs ?? 20000;
  const text = 'Please add a unit test for the date parser in src/utils/date.ts.';
  try {
    const r = await post(`${c.url}/v1/chat/completions`, c.apiKey, { model: c.model, messages: [{ role: 'user', content: text }], max_tokens: 80, temperature: 0, stream: false }, t);
    if (r.status === 400 && /decisions? model/i.test(r.text)) return { adapter: 'decisions', why: 'The server said it is a decisions model, answered only on the Decisions API.', raw: r.text.slice(0, 600) };
    if (!r.ok) {
      const k = await post(`${c.url}/classify`, c.apiKey, { model: c.model, input: [text] }, t);
      if (k.ok && parseClassify(tryJson(k.text), 1)) return { adapter: 'classifier', why: 'Chat failed but /classify returned scores.', raw: k.text.slice(0, 600) };
      return { adapter: 'json_judge', why: `The probe failed (${r.status}); could not tell. Pick a format by hand.`, raw: r.text.slice(0, 600) };
    }
    const j = tryJson(r.text) as { choices?: { message?: { content?: string } }[] } | null;
    const out = (j?.choices?.[0]?.message?.content ?? '').trim();
    const json = (() => {
      const m = out.match(/\{[\s\S]*\}/);
      return m ? (tryJson(m[0]) as Record<string, unknown> | null) : null;
    })();
    if (/^\s*(safe|unsafe)\b/i.test(out)) return { adapter: 'llama_guard', why: 'It answered "safe" / "unsafe" (Llama Guard style).', raw: out };
    if (/^\W*(yes|no)\b/i.test(out)) return { adapter: 'yes_no', why: 'It answered Yes / No.', raw: out };
    if (/Safety:\s*\w+/i.test(out)) return { adapter: 'custom', preset: 'qwen3guard', why: 'It answered "Safety: …" (Qwen3Guard style).', raw: out };
    if (/Harmful request:\s*(yes|no)/i.test(out)) return { adapter: 'custom', preset: 'wildguard', why: 'It answered "Harmful request: …" (WildGuard style).', raw: out };
    if (json && 'User Safety' in json) return { adapter: 'custom', preset: 'nemoguard', why: 'It answered {"User Safety": …} (NemoGuard / Aegis style).', raw: out };
    if (json && 'violation' in json) return { adapter: 'custom', preset: 'gpt_oss_safeguard', why: 'It answered {"violation": …} (gpt-oss-safeguard style).', raw: out };
    if (json && ('verdict' in json || 'decision' in json)) return { adapter: 'json_judge', why: 'It answered the JSON judge contract.', raw: out };
    if (json) return { adapter: 'custom', why: `It answered JSON with ${Object.keys(json).slice(0, 5).join(', ')}: set the paths in Custom mapping.`, raw: out };
    return { adapter: 'json_judge', why: 'It chats normally, so it works as a JSON judge with a system prompt.', raw: out };
  } catch (e) {
    return { adapter: 'json_judge', why: `The probe failed: ${(e as Error).message}`, raw: '' };
  }
}
