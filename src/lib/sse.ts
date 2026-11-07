/**
 * A blocked request still gets a normal assistant reply, so agents like Cline show
 * it in the chat instead of retrying or surfacing a raw error.
 */
export function blockedResponse(opts: { stream: boolean; model: string; text: string; requestId: string; kind: 'chat' | 'completions'; roleSent?: boolean }) {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${opts.requestId}`;
  const headers = { 'x-guardrail-request-id': opts.requestId, 'x-opsara-request-id': opts.requestId, 'x-guardrail-blocked': '1', 'x-opsara-blocked': '1' };

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
      if (opts.kind === 'chat' && !opts.roleSent) send(chunk({ role: 'assistant', content: '' }, null));
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
  return Response.json({ error: { message, type, code: code ?? null, param: null } }, { status, headers: { 'x-guardrail-request-id': requestId, 'x-opsara-request-id': requestId } });
}

/** Send a finished chat or completions answer as an SSE stream (for answers checked before the client saw them). */
export function sseFromJson(json: Record<string, unknown>, opts: { requestId: string; kind: 'chat' | 'completions'; /** The role chunk (and live reasoning) already went out. */ roleSent?: boolean }) {
  const enc = new TextEncoder();
  const j = json as { id?: string; created?: number; model?: string; usage?: unknown; choices?: { message?: { content?: string | null; tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[]; reasoning?: string }; text?: string; finish_reason?: string | null }[] };
  const c = j.choices?.[0];
  const base = { id: j.id ?? `chatcmpl-${opts.requestId}`, created: j.created ?? Math.floor(Date.now() / 1000), model: j.model ?? '' };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    opts.kind === 'chat' ? { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] } : { ...base, object: 'text_completion', choices: [{ index: 0, text: String(delta.content ?? ''), finish_reason: finish }] };
  const text = opts.kind === 'chat' ? (c?.message?.content ?? '') : (c?.text ?? '');
  const pieces = text ? (text.match(/[\s\S]{1,80}/g) ?? [text]) : [];
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) {
      const send = (o: unknown) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
      if (opts.kind === 'chat' && !opts.roleSent) send(chunk({ role: 'assistant', content: '' }));
      for (const p of pieces) send(chunk({ content: p }));
      const calls = c?.message?.tool_calls ?? [];
      if (calls.length) send(chunk({ tool_calls: calls.map((t, i) => ({ index: i, id: t.id, type: t.type ?? 'function', function: { name: t.function?.name, arguments: t.function?.arguments ?? '' } })) }));
      send({ ...chunk({}, c?.finish_reason ?? 'stop'), ...(j.usage ? { usage: j.usage } : {}) });
      ctl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctl.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'x-guardrail-request-id': opts.requestId, 'x-opsara-request-id': opts.requestId, 'x-guardrail-checked': '1' } });
}
