import { describe, expect, it } from 'vitest';
import { EarlyStream } from '@/lib/early-stream';

const read = async (r: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await r.read()).value);

describe('EarlyStream', () => {
  it('sends the role first, then thinking, then the request own stream', async () => {
    const e = new EarlyStream();
    e.open({ id: 'req_1', model: 'm' });
    e.status('Checking…', 'checking');
    const res = e.response(Promise.resolve(new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })));
    const text = await res.text();
    expect(res.headers.get('x-opsara-request-id')).toBe('req_1');
    expect(text.indexOf('"role":"assistant"')).toBeLessThan(text.indexOf('Checking…'));
    expect(text.indexOf('Checking…')).toBeLessThan(text.indexOf('"content":"hi"'));
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('turns an error reply into an error event instead of a status the client can no longer get', async () => {
    const e = new EarlyStream();
    e.open({ id: 'req_2', model: 'm' });
    const res = e.response(Promise.resolve(Response.json({ error: { message: 'No server for m is reachable right now.', type: 'api_error', code: 'backend_unavailable' } }, { status: 502 })));
    const text = await res.text();
    expect(text).toContain('"error":{"message":"No server for m is reachable right now."');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('notes when the client leaves, stops sending, and does not throw', async () => {
    const e = new EarlyStream();
    e.open({ id: 'req_3', model: 'm' });
    let left: { sec: number; phase: string } | null = null;
    e.onCancel = (sec, phase) => (left = { sec, phase });
    e.status('Checking…', 'checking the answer');
    const res = e.response(new Promise<Response>(() => {}));
    const reader = res.body!.getReader();
    await read(reader);
    await reader.cancel();
    expect(left).toMatchObject({ phase: 'checking the answer' });
    expect(e.cancelled).toBe(true);
    expect(() => e.think('more')).not.toThrow();
  });
});
