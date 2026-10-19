/**
 * A blocked request still gets a normal assistant reply, so agents like Cline show
 * it in the chat instead of retrying or surfacing a raw error.
 */
export function blockedResponse(opts: { stream: boolean; model: string; text: string; requestId: string; kind: 'chat' | 'completions' }) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${opts.requestId}`;
  const headers = { 'x-guardrail-request-id': opts.requestId, 'x-guardrail-blocked': '1' };

  if (!opts.stream) {
    const body =
      opts.kind === 'chat'
        ? {
            id,
            object: 'chat.completion',
            created,
            model: opts.model,
            choices: [{ index: 0, message: { role: 'assistant', content: opts.text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }
        : { id, object: 'text_completion', created, model: opts.model, choices: [{ index: 0, text: opts.text, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
    return Response.json(body, { headers });
  }

  const enc = new TextEncoder();
  const pieces = opts.text.match(/[^\s]+\s*|\s+/g) ?? [opts.text];
  const chunk = (delta: Record<string, unknown> | null, finish: string | null, text?: string) =>
    opts.kind === 'chat'
      ? { id, object: 'chat.completion.chunk', created, model: opts.model, choices: [{ index: 0, delta: delta ?? {}, finish_reason: finish }] }
      : { id, object: 'text_completion', created, model: opts.model, choices: [{ index: 0, text: text ?? '', finish_reason: finish }] };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const send = (o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      if (opts.kind === 'chat') send(chunk({ role: 'assistant', content: '' }, null));
      for (const p of pieces) send(opts.kind === 'chat' ? chunk({ content: p }, null) : chunk(null, null, p));
      send(chunk({}, 'stop'));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}

/** OpenAI-shaped error body. */
export function apiError(status: number, message: string, type: string, requestId: string, code?: string) {
  return Response.json({ error: { message, type, code: code ?? null, param: null } }, { status, headers: { 'x-guardrail-request-id': requestId } });
}
