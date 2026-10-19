/**
 * Known request schemas and a scorer that says which one a request looks like.
 * Every request is scored against all of them; the best match is logged.
 */
export interface SchemaDef {
  id: string;
  name: string;
  path: string;
  forwardable: boolean; // the gateway can send it to vLLM as is
  description: string;
}

export const SCHEMAS: SchemaDef[] = [
  { id: 'openai_chat', name: 'OpenAI Chat Completions', path: '/v1/chat/completions', forwardable: true, description: 'Cline, Continue, Roo Code, most OpenAI-compatible clients.' },
  { id: 'openai_completions', name: 'OpenAI Completions (legacy)', path: '/v1/completions', forwardable: true, description: 'Plain prompt in, text out. Used by autocomplete tools.' },
  { id: 'openai_responses', name: 'OpenAI Responses', path: '/v1/responses', forwardable: false, description: 'Newer OpenAI API with input items and instructions.' },
  { id: 'anthropic_messages', name: 'Anthropic Messages', path: '/v1/messages', forwardable: false, description: 'Claude Code and the Anthropic SDKs.' },
  { id: 'ollama_chat', name: 'Ollama Chat', path: '/api/chat', forwardable: false, description: 'Ollama clients and plugins.' },
  { id: 'gemini', name: 'Google Gemini', path: ':generateContent', forwardable: false, description: 'Gemini SDKs, contents with parts.' },
];

type Body = Record<string, unknown>;
type Signal = [weight: number, test: (b: Body, path: string, h: Headers) => boolean];

const arr = (v: unknown): v is unknown[] => Array.isArray(v);
const obj = (v: unknown): v is Body => !!v && typeof v === 'object' && !Array.isArray(v);
const msgs = (b: Body) => (arr(b.messages) ? (b.messages as unknown[]).filter(obj) : []);
const hasBlocks = (b: Body, types: string[]) =>
  msgs(b).some((m) => arr(m.content) && (m.content as unknown[]).some((c) => obj(c) && types.includes(String(c.type))));

const SIGNALS: Record<string, Signal[]> = {
  openai_chat: [
    [2, (_, p) => p.endsWith('/chat/completions')],
    [3, (b) => msgs(b).length > 0],
    [2, (b) => msgs(b).some((m) => m.role === 'system')],
    [2, (b) => msgs(b).length > 0 && b.system === undefined],
    [1, (b) => b.prompt === undefined && b.contents === undefined && b.input === undefined],
    [1, (b) => b.max_tokens === undefined || typeof b.max_tokens === 'number' || b.max_completion_tokens !== undefined],
    [1, (b) => !hasBlocks(b, ['tool_use', 'tool_result'])],
    [1, (b) => b.options === undefined],
  ],
  openai_completions: [
    [3, (_, p) => /\/v1\/completions$/.test(p)],
    [4, (b) => typeof b.prompt === 'string' || arr(b.prompt)],
    [1, (b) => b.messages === undefined],
  ],
  openai_responses: [
    [3, (_, p) => p.endsWith('/responses')],
    [3, (b) => b.input !== undefined],
    [2, (b) => typeof b.instructions === 'string' || b.previous_response_id !== undefined || b.max_output_tokens !== undefined],
    [1, (b) => b.messages === undefined],
  ],
  anthropic_messages: [
    [2, (_, p) => p.endsWith('/messages') && !p.endsWith('/chat/completions')],
    [3, (_, __, h) => h.has('anthropic-version')],
    [3, (b) => b.system !== undefined],
    [1, (b) => typeof b.max_tokens === 'number'],
    [2, (b) => hasBlocks(b, ['tool_use', 'tool_result', 'text', 'image']) && !msgs(b).some((m) => m.role === 'system')],
    [1, (b) => msgs(b).length > 0 && !msgs(b).some((m) => m.role === 'system' || m.role === 'tool')],
  ],
  ollama_chat: [
    [3, (_, p) => p.startsWith('/api/')],
    [2, (b) => obj(b.options)],
    [1, (b) => msgs(b).length > 0],
    [1, (b) => b.format !== undefined || b.keep_alive !== undefined],
  ],
  gemini: [
    [3, (_, p) => p.includes(':generateContent') || p.includes(':streamGenerateContent')],
    [4, (b) => arr(b.contents) && (b.contents as unknown[]).some((c) => obj(c) && arr(c.parts))],
    [1, (b) => obj(b.generationConfig) || obj(b.systemInstruction)],
  ],
};

export interface Detection {
  best: SchemaDef;
  confidence: number;
  scores: { id: string; name: string; score: number }[];
}

export function detectSchema(body: unknown, path: string, headers: Headers = new Headers()): Detection {
  const b = obj(body) ? body : {};
  const scores = SCHEMAS.map((s) => {
    const sig = SIGNALS[s.id];
    const total = sig.reduce((a, [w]) => a + w, 0);
    const got = sig.reduce((a, [w, t]) => {
      try {
        return a + (t(b, path, headers) ? w : 0);
      } catch {
        return a;
      }
    }, 0);
    return { id: s.id, name: s.name, score: Math.round((got / total) * 100) / 100 };
  }).sort((a, z) => z.score - a.score);
  const best = SCHEMAS.find((s) => s.id === scores[0].id)!;
  return { best, confidence: scores[0].score, scores };
}

/** Which schema a path is meant to carry. */
export function schemaForPath(path: string): SchemaDef | undefined {
  if (path.endsWith('/chat/completions')) return SCHEMAS[0];
  if (path.endsWith('/completions')) return SCHEMAS[1];
  return undefined;
}
