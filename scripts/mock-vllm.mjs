#!/usr/bin/env node
// A tiny stand-in for a vLLM server, for local development and tests.
// It speaks the parts of vLLM's API Opsara uses:
//   GET  /v1/models            model list
//   POST /v1/chat/completions  chat (streams when asked); a "safeguard" model answers as a judge
//   POST /v1/completions       legacy completions
//   POST /classify             PIGuard-style classifier: probs [benign, injection]
//   GET  /metrics              prefix cache counters
//
// Usage: node scripts/mock-vllm.mjs [port] [model,model,...]
import http from 'node:http';
// Delay between streamed words (ms); raise it to watch streaming, e.g. MOCK_TOKEN_MS=120.
const TOKEN_MS = Number(process.env.MOCK_TOKEN_MS) || 5;

const port = Number(process.argv[2] ?? process.env.PORT ?? 8000);
const models = (process.argv[3] ?? process.env.MODELS ?? 'qwen3-coder-30b,gpt-oss-120b').split(',').filter(Boolean);
let hits = 0;
let queries = 0;
const seenPrefixes = new Set();

const RISKY = [/ignore (all |any )?(previous|prior) (instructions|rules)/i, /id_rsa|\.ssh|\.env\b|credentials/i, /curl[^|]*\|\s*(ba)?sh/i, /rm\s+-rf\s+\//i];

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(s || '{}'));
      } catch {
        resolve(null);
      }
    });
  });

const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('\n') : '');

function judge(messages) {
  const content = text(messages.at(-1)?.content);
  const bad = RISKY.some((r) => r.test(content)) && !/fake|fixture|test data/i.test(content);
  return JSON.stringify(bad ? { verdict: 'block', reason: 'The new content asks the agent to handle secrets or run something dangerous that the user did not ask for.' } : { verdict: 'allow', reason: 'Ordinary coding work; nothing tries to change the assistant’s rules.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    return send(res, 200, { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'vllm', max_model_len: id.includes('guard') ? 512 : 262144 })) });
  }
  if (req.method === 'GET' && url.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`# HELP vllm:prefix_cache_queries_total x\nvllm:prefix_cache_queries_total{model_name="m"} ${queries}\nvllm:prefix_cache_hits_total{model_name="m"} ${hits}\n`);
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  const body = await readBody(req);
  if (!body) return send(res, 400, { error: { message: 'bad json' } });

  if (url.pathname === '/classify') {
    const input = Array.isArray(body.input) ? body.input : [body.input];
    return send(res, 200, {
      data: input.map((t, index) => {
        const p = RISKY.some((r) => r.test(String(t))) ? 0.93 : 0.04;
        return { index, label: p > 0.5 ? 'injection' : 'benign', probs: [1 - p, p], num_classes: 2 };
      }),
    });
  }

  if (!models.includes(body.model)) return send(res, 404, { error: { message: `The model \`${body.model}\` does not exist.`, type: 'NotFoundError', code: 404 } });

  const chat = url.pathname === '/v1/chat/completions';
  const messages = chat ? body.messages ?? [] : [{ role: 'user', content: body.prompt }];
  // Like vLLM: stream_options is only valid together with stream: true.
  if (body.stream_options && !body.stream) return send(res, 400, { error: { message: 'Stream options can only be defined when `stream=True`. (parameter=stream_options)', type: 'BadRequestError', param: 'stream_options', code: 400 } });
  // Count a prefix-cache hit when the first message repeats.
  const prefix = text(messages[0]?.content).slice(0, 2000);
  queries += 1;
  if (seenPrefixes.has(prefix)) hits += 1;
  seenPrefixes.add(prefix);

  // After Opsara's retry feedback, answer cleanly (tests the after-the-model retry loop).
  const fixed = /previous answer was rejected/i.test(text(messages.at(-1)?.content));
  const reply = body.model.includes('safeguard') ? judge(messages) : fixed ? 'Here is a safe answer that follows the rules.' : `Mock answer from ${body.model}. I received ${messages.length} message(s); the first starts with: ${text(messages[0]?.content).slice(0, 80).replace(/\s+/g, ' ')}; the last says: ${text(messages.at(-1)?.content).slice(0, 120).replace(/\s+/g, ' ')}`;
  const created = Math.floor(Date.now() / 1000);
  const id = `cmpl-mock-${Date.now()}`;

  // Scripted tool calling (for the console agent): a user message "[tool:name {json args}]" makes the
  // model call that tool; after the tool answers, it replies "Done: …" with the result.
  if (chat && Array.isArray(body.tools)) {
    const last = messages.at(-1);
    const m = last?.role === 'user' ? /^\[tool:(\w+)\s*(\{[\s\S]*\})?\]$/.exec(text(last.content).trim()) : null;
    const call = m ? { id: `call_${Date.now()}`, type: 'function', function: { name: m[1], arguments: m[2] ?? '{}' } } : null;
    const answer = last?.role === 'tool' ? `Done: ${text(last.content).slice(0, 200)}` : call ? '' : `Mock agent here. I received: ${text(last?.content).slice(0, 120)}`;
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant', content: '' });
      if (call) {
        chunk({ tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] });
        chunk({}, 'tool_calls');
      } else {
        for (const w of answer.match(/\S+\s*/g) ?? [answer]) {
          chunk({ content: w });
          await new Promise((r) => setTimeout(r, TOKEN_MS));
        }
        chunk({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    return send(res, 200, { id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: answer || null, ...(call ? { tool_calls: [call] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }] });
  }
  const words = reply.match(/\S+\s*/g) ?? [reply];

  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (chat) chunk({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    for (const w of words) {
      chunk(chat ? { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] } : { id, object: 'text_completion', created, model: body.model, choices: [{ index: 0, text: w, finish_reason: null }] });
      await new Promise((r) => setTimeout(r, TOKEN_MS));
    }
    chunk(chat ? { id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] } : { id, object: 'text_completion', created, model: body.model, choices: [{ index: 0, text: '', finish_reason: 'stop' }] });
    res.end('data: [DONE]\n\n');
    return;
  }
  const usage = { prompt_tokens: 10, completion_tokens: words.length, total_tokens: 10 + words.length };
  if (chat) return send(res, 200, { id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage });
  return send(res, 200, { id, object: 'text_completion', created, model: body.model, choices: [{ index: 0, text: reply, finish_reason: 'stop' }], usage });
});

server.listen(port, () => console.log(`mock vLLM on http://127.0.0.1:${port} serving ${models.join(', ')}`));
