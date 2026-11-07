// The guard pipeline: an ordered list of layers between "key accepted" and "call the model".
// The old fixed pair (PIGuard, then the OSS judge) becomes two layers with ids "piguard" and "judge".
import { type AdapterId, ADAPTERS, detectAdapter } from './adapters';
import { DECISION_DEFAULT, type DecisionSchema, ROUTING_PRESET, normalizeDecision } from './decisions';
import { type CustomMapping, normalizeMapping, presetFor, withPreset, MAPPING_DEFAULT } from './mapping';
import type { Scan } from './guard';

export const LAYER_TYPES = {
  classifier: 'Classifier model (PIGuard, Llama Guard, moderation…)',
  judge: 'LLM judge with a system prompt',
  patterns: 'Built-in injection patterns (no model)',
  redactor: 'Built-in secrets and PII redactor (no model)',
  router: 'Router: a decision model picks which model answers',
} as const;
export type LayerType = keyof typeof LAYER_TYPES;

export interface GuardLayer {
  id: string;
  name: string;
  /** The default for every group; groups can switch a layer on or off for themselves. */
  enabled: boolean;
  type: LayerType;
  adapter: AdapterId | 'auto';
  serverId: number | null;
  model: string;
  /** System prompt for judges. Groups can add lines. */
  prompt: string;
  /** Extra guidance appended to the judge prompt. */
  passHint: string;
  failHint: string;
  /** Score at or above which a scoring model counts as a hit. */
  threshold: number;
  /** For classifiers whose output is a probability list: which index means "attack". */
  labelIndex: number;
  /** "all": every request. "flagged": only when an earlier layer flagged it, or when no earlier layer screened it. */
  scope: 'all' | 'flagged';
  /**
   * What a hit does: stop the request, pass it on to later layers as flagged, or redact the match.
   * After-the-model layers can also "retry": ask the model to answer again with the reason as feedback.
   */
  onFail: 'block' | 'flag' | 'redact' | 'retry';
  /** "input" (default) checks the request before the model; "output" checks the model's answer. */
  stage?: 'input' | 'output';
  /** Output layers that retry: how many new answers to ask for (0-5). */
  retries?: number;
  /** Output layers: when the answer still fails after the retries, block it or let it through flagged. */
  onExhausted?: 'block' | 'flag';
  /** Output layers: the feedback added after a rejected answer. {reason}, {categories}, {verdict}. */
  retryPrompt?: string;
  /** Output layers: check only the tool calls in the answer (cheaper), not its text. */
  toolCallsOnly?: boolean;
  /** When the model fails, times out or answers nonsense. "patterns" falls back to the built-in patterns. */
  onError: 'allow' | 'block' | 'patterns';
  timeoutMs: number;
  reasoningEffort: 'low' | 'medium' | 'high';
  /** For the "custom" adapter: how to call the model and read its answer (null: the preset for the model, if any). */
  mapping?: CustomMapping | null;
  /** For decision models: the question asked and what each answer means (null: the default injection question). */
  decision?: DecisionSchema | null;
  /**
   * Where the check goes. "prefix": the layer prompt first, then the content to check (default).
   * "suffix": the request exactly as it will reach the model (system prompt, context, tools, every
   * message), then the check question last, so a server with prefix caching reuses the cache.
   */
  placement?: 'prefix' | 'suffix';
  /** Suffix layers: check with the request's own model and server instead of `model`, so the cache is shared. */
  sameModel?: boolean;
  /** What this layer reads; null uses the global "What the layers read" setting. */
  reads?: Scan | null;
  /** Router layers: the model each answer sends the request to. */
  routes?: Record<string, string> | null;
  /** Router layers: the model when the answer has no route or the decision fails; empty keeps the client's model. */
  fallbackModel?: string;
}

/** The feedback sent with a rejected answer (after-the-model layers that retry). */
export const RETRY_PROMPT = 'Your previous answer was rejected by a safety check: {reason}. Please answer again without that problem.';

/** The longest time limit a layer may have (10 minutes). Long suffix checks on big conversations can need minutes. */
export const MAX_LAYER_TIMEOUT_MS = 600_000;

export const LAYER_DEFAULTS: Omit<GuardLayer, 'id' | 'name' | 'type'> = {
  enabled: true,
  adapter: 'auto',
  serverId: null,
  model: '',
  prompt: '',
  passHint: '',
  failHint: '',
  threshold: 0.7,
  labelIndex: 1,
  scope: 'all',
  onFail: 'block',
  onError: 'block',
  timeoutMs: 5000,
  reasoningEffort: 'low',
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => ((allowed as readonly string[]).includes(String(v)) ? (v as T) : d);
const clamp = (n: unknown, lo: number, hi: number, d: number) => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};

/** Clean one layer from untrusted input. */
export function normalizeLayer(raw: Partial<GuardLayer>, i = 0): GuardLayer {
  const type = pick(raw.type, Object.keys(LAYER_TYPES) as LayerType[], 'judge');
  const id = String(raw.id ?? '').trim().replace(/[^a-z0-9_-]/gi, '').slice(0, 40) || `layer-${Date.now().toString(36)}-${i}`;
  return {
    id,
    name: String(raw.name ?? '').trim().slice(0, 80) || LAYER_TYPES[type],
    enabled: raw.enabled !== false,
    type,
    adapter: raw.adapter === 'auto' ? 'auto' : pick(raw.adapter, Object.keys(ADAPTERS) as AdapterId[], 'auto' as AdapterId),
    serverId: raw.serverId ? Number(raw.serverId) || null : null,
    model: String(raw.model ?? '').trim(),
    prompt: String(raw.prompt ?? ''),
    passHint: String(raw.passHint ?? ''),
    failHint: String(raw.failHint ?? ''),
    threshold: clamp(raw.threshold, 0.05, 0.99, LAYER_DEFAULTS.threshold),
    labelIndex: Math.round(clamp(raw.labelIndex, 0, 99, 1)),
    scope: pick(raw.scope, ['all', 'flagged'] as const, 'all'),
    onFail: pick(raw.onFail, raw.stage === 'output' ? (['block', 'flag', 'redact', 'retry'] as const) : (['block', 'flag', 'redact'] as const), type === 'redactor' ? 'redact' : raw.stage === 'output' ? 'retry' : 'block'),
    stage: raw.stage === 'output' ? 'output' : 'input',
    retries: Math.round(clamp(raw.retries, 0, 5, 2)),
    onExhausted: raw.onExhausted === 'flag' ? 'flag' : 'block',
    retryPrompt: String(raw.retryPrompt ?? '').trim() || RETRY_PROMPT,
    toolCallsOnly: raw.toolCallsOnly === true,
    onError: pick(raw.onError, ['allow', 'block', 'patterns'] as const, 'block'),
    timeoutMs: Math.round(clamp(raw.timeoutMs, 200, MAX_LAYER_TIMEOUT_MS, LAYER_DEFAULTS.timeoutMs)),
    reasoningEffort: pick(raw.reasoningEffort, ['low', 'medium', 'high'] as const, 'low'),
    mapping: raw.mapping ? normalizeMapping(raw.mapping) : null,
    decision: raw.decision ? normalizeDecision(raw.decision) : null,
    routes: raw.routes && typeof raw.routes === 'object' ? Object.fromEntries(Object.entries(raw.routes as Record<string, unknown>).filter(([k, v]) => k.trim() && typeof v === 'string' && v.trim()).map(([k, v]) => [k.trim().slice(0, 80), String(v).trim()])) : null,
    fallbackModel: String(raw.fallbackModel ?? '').trim(),
    placement: raw.placement === 'suffix' ? 'suffix' : 'prefix',
    sameModel: raw.sameModel === true,
    reads: raw.reads && typeof raw.reads === 'object' ? { user: !!raw.reads.user, tool: !!raw.reads.tool, system: !!raw.reads.system, toolCalls: !!raw.reads.toolCalls, history: !!raw.reads.history } : null,
  };
}

/** What the model's server said about it, when known (see servers.modelMeta). */
export interface ModelMeta {
  api?: string | null;
  structured?: boolean;
}

/**
 * The adapter "Auto" picks, and why, in this order: the server's own metadata (OpenRouter marks
 * Decisions-API models), then the model's name (known guard families), then the layer type.
 */
export function autoAdapter(l: Pick<GuardLayer, 'type' | 'model'>, meta?: ModelMeta | null): { adapter: AdapterId; why: string } {
  if (meta?.api === 'decisions') return { adapter: 'decisions', why: 'the server lists it as a Decisions API model' };
  if (!l.model) return { adapter: l.type === 'judge' ? 'json_judge' : 'classifier', why: 'no model picked yet' };
  const byName = detectAdapter(l.model);
  if (byName === 'decisions') return { adapter: 'decisions', why: 'its name is a known decision model' };
  if (l.type === 'judge') {
    if (byName !== 'json_judge' && byName !== 'classifier') return { adapter: byName, why: 'its name is a known guard model family' };
    return { adapter: 'json_judge', why: meta?.structured ? 'a chat model; the server supports structured output, so the answer is forced to JSON' : 'a chat model with a system prompt' };
  }
  if (byName === 'json_judge') return { adapter: 'classifier', why: 'a classifier layer' };
  return { adapter: byName, why: 'its name is a known guard model family' };
}

/** The adapter a layer actually uses. */
export function adapterFor(l: GuardLayer, meta?: ModelMeta | null): AdapterId {
  if (l.type === 'router') return 'decisions';
  return l.adapter !== 'auto' ? l.adapter : autoAdapter(l, meta).adapter;
}

interface Legacy {
  threshold: number;
  piguard: { enabled: boolean; mode: 'builtin' | 'vllm'; serverId: number | null; model: string; labelIndex: number };
  oss: { enabled: boolean; serverId: number | null; model: string; prompt: string; reasoningEffort: 'low' | 'medium' | 'high'; timeoutMs: number; onTimeout: 'block' | 'allow' };
}

/** The two layers that reproduce the old PIGuard + OSS pair exactly. */
export function layersFromLegacy(g: Legacy): GuardLayer[] {
  return [
    normalizeLayer({
      id: 'piguard',
      name: 'PIGuard',
      enabled: g.piguard.enabled,
      type: g.piguard.mode === 'vllm' && g.piguard.serverId ? 'classifier' : 'patterns',
      adapter: 'classifier',
      serverId: g.piguard.serverId,
      model: g.piguard.model,
      threshold: g.threshold,
      labelIndex: g.piguard.labelIndex,
      scope: 'all',
      onFail: 'flag',
      onError: 'patterns',
    }),
    normalizeLayer({
      id: 'judge',
      name: 'OSS judge',
      enabled: g.oss.enabled,
      type: 'judge',
      adapter: 'json_judge',
      serverId: g.oss.serverId,
      model: g.oss.model,
      prompt: g.oss.prompt,
      scope: 'flagged',
      onFail: 'block',
      onError: g.oss.onTimeout,
      timeoutMs: g.oss.timeoutMs,
      reasoningEffort: g.oss.reasoningEffort,
    }),
  ];
}

/** Keep the "piguard" and "judge" layers in step when the old settings fields are written (old UI, tests). */
export function syncLegacy(layers: GuardLayer[], g: Legacy, patch: { piguard?: object; oss?: object; threshold?: unknown }): GuardLayer[] {
  return layers.map((l) => {
    if (l.id === 'piguard' && (patch.piguard || patch.threshold !== undefined)) {
      const [fresh] = layersFromLegacy(g);
      return { ...l, enabled: fresh.enabled, type: fresh.type, serverId: fresh.serverId, model: fresh.model, threshold: fresh.threshold, labelIndex: fresh.labelIndex };
    }
    if (l.id === 'judge' && patch.oss) {
      const fresh = layersFromLegacy(g)[1];
      return { ...l, enabled: fresh.enabled, serverId: fresh.serverId, model: fresh.model, prompt: fresh.prompt, onError: fresh.onError, timeoutMs: fresh.timeoutMs, reasoningEffort: fresh.reasoningEffort };
    }
    return l;
  });
}

/** The mapping a custom-adapter layer uses: its own, else the ready preset for its model, else the default. */
export function mappingFor(l: GuardLayer): CustomMapping {
  if (l.mapping) return l.mapping;
  const p = presetFor(l.model);
  return p ? withPreset(p) : MAPPING_DEFAULT;
}

/** The question a decision-model layer asks: its own, else the default prompt-injection question. */
export const decisionFor = (l: GuardLayer): DecisionSchema => l.decision ?? (l.type === 'router' ? ROUTING_PRESET : DECISION_DEFAULT);

/** Formats that send a chat request with a system prompt, so the check can go after the conversation. */
export const canSuffix = (a: AdapterId) => a === 'json_judge' || a === 'text' || a === 'yes_no';
