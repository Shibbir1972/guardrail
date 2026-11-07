// Put a streamed (SSE) reply back together for the log, chunk by chunk, while the stream passes
// through untouched. Works for chat (delta.content, delta.tool_calls, reasoning) and completions (text).
import type { ModelResponse } from './logs';

/** Replies longer than this are cut in the log (the client still gets everything). */
export const RESPONSE_LIMIT = 1_000_000;

type ToolCall = { id?: string; type?: string; function: { name?: string; arguments: string } };

export class StreamCollector {
  private content = '';
  private reasoning = '';
  private tools: ToolCall[] = [];
  private finish: string | null = null;
  private usage: ModelResponse['usage'] = null;
  private truncated = false;
  private tail = '';
  /** The backend that answered (OpenRouter puts "provider" on each chunk). */
  provider: string | null = null;
  /** Called with each piece of reasoning ("thinking") as it arrives, so a caller can pass it on live. */
  onReasoning?: (text: string) => void;

  /** Feed raw text from the stream; it may split lines anywhere. */
  push(chunk: string) {
    const lines = (this.tail + chunk).split('\n');
    this.tail = lines.pop() ?? '';
    for (const l of lines) this.line(l);
  }

  private add(kind: 'content' | 'reasoning', text: string) {
    const room = RESPONSE_LIMIT - this.content.length - this.reasoning.length;
    if (room <= 0) return void (this.truncated = true);
    if (text.length > room) this.truncated = true;
    this[kind] += text.slice(0, room);
  }

  private line(l: string) {
    const t = l.trim();
    if (!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j: {
      choices?: { delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }[] }; text?: string; finish_reason?: string | null }[];
      usage?: ModelResponse['usage'];
    };
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.usage) this.usage = j.usage;
    if (typeof (j as { provider?: unknown }).provider === 'string') this.provider = (j as { provider: string }).provider;
    const c = j.choices?.[0];
    if (!c) return;
    if (c.finish_reason) this.finish = c.finish_reason;
    if (typeof c.text === 'string') this.add('content', c.text);
    const d = c.delta;
    if (!d) return;
    if (typeof d.content === 'string') this.add('content', d.content);
    const r = d.reasoning ?? d.reasoning_content;
    if (typeof r === 'string') {
      this.add('reasoning', r);
      if (r) this.onReasoning?.(r);
    }
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? this.tools.length;
      const cur = (this.tools[i] ??= { function: { arguments: '' } });
      if (tc.id) cur.id = tc.id;
      if (tc.type) cur.type = tc.type;
      if (tc.function?.name) cur.function.name = (cur.function.name ?? '') + tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
    }
  }

  result(opts: { interrupted?: boolean } = {}): ModelResponse {
    if (this.tail) this.line(this.tail);
    this.tail = '';
    const tools = this.tools.filter(Boolean);
    return {
      message: { role: 'assistant', content: this.content, ...(tools.length ? { tool_calls: tools } : {}), ...(this.reasoning ? { reasoning: this.reasoning } : {}) },
      finish_reason: this.finish,
      usage: this.usage,
      streamed: true,
      ...(this.provider ? { provider: this.provider } : {}),
      ...(opts.interrupted ? { interrupted: true } : {}),
      ...(this.truncated ? { truncated: true } : {}),
    };
  }
}

/** The reply of a non-streamed chat or completions answer. */
export function responseFromJson(json: unknown): ModelResponse {
  const j = json as { choices?: { message?: ModelResponse['message']; text?: string; finish_reason?: string | null }[]; usage?: ModelResponse['usage']; provider?: string };
  const c = j?.choices?.[0];
  const message: ModelResponse['message'] = c?.message ? { ...c.message, role: c.message.role ?? 'assistant' } : { role: 'assistant', content: c?.text ?? '' };
  let truncated = false;
  if (typeof message.content === 'string' && message.content.length > RESPONSE_LIMIT) {
    message.content = message.content.slice(0, RESPONSE_LIMIT);
    truncated = true;
  }
  return { message, finish_reason: c?.finish_reason ?? null, usage: j?.usage ?? null, ...(typeof j?.provider === 'string' ? { provider: j.provider } : {}), ...(truncated ? { truncated: true } : {}) };
}
