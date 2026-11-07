// Opens the streamed reply of a chat request before the guard layers have finished, and fills the wait with
// short "thinking" lines. Agents such as Cline give up on a request that stays silent for a while, and the
// checks (and a retry) can take longer than that. Thinking (reasoning_content) is never executed and the model's
// template drops it from the next prompt, so it is safe to show: the answer and tool calls still come only
// after the checks pass.

const enc = new TextEncoder();
const HEARTBEAT_MS = 3000;

export class EarlyStream {
  private c: ReadableStreamDefaultController<Uint8Array> | null = null;
  private queue: Uint8Array[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSend = 0;
  private openedAt = 0;
  private id = '';
  private model = '';
  private created = Math.floor(Date.now() / 1000);
  private resolveOpened!: () => void;
  /** Resolves when the request needs a stream before its result is known. */
  readonly opened = new Promise<void>((r) => (this.resolveOpened = r));
  active = false;
  cancelled = false;
  /** What the request is waiting for, for the log if the client leaves. */
  phase = 'starting';
  /** Called once if the client stops waiting: seconds since the stream opened, and the phase. */
  onCancel?: (seconds: number, phase: string) => void;

  open(info: { id: string; model: string }) {
    if (this.active) return;
    this.active = true;
    this.id = info.id;
    this.model = info.model;
    this.openedAt = Date.now();
    this.resolveOpened();
  }

  private chunk(delta: Record<string, unknown>) {
    return enc.encode(`data: ${JSON.stringify({ id: `chatcmpl-${this.id}`, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  }

  private write(b: Uint8Array) {
    if (this.cancelled) return;
    if (!this.c) return void this.queue.push(b);
    try {
      this.c.enqueue(b);
    } catch {
      this.leave();
    }
  }

  /** A piece of thinking, passed on at once. */
  think(text: string) {
    if (!this.active || this.cancelled || !text) return;
    this.lastSend = Date.now();
    this.write(this.chunk({ reasoning_content: text }));
  }

  /** A status line in the thinking, and what the request is now waiting for. */
  status(text: string, phase?: string) {
    if (phase) this.phase = phase;
    if (text) this.think(`${text}\n`);
  }

  private leave() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stop();
    this.onCancel?.(Math.round((Date.now() - this.openedAt) / 100) / 10, this.phase);
  }

  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The reply to send now: role and first line at once, then whatever the request produces. */
  response(result: Promise<Response>): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.c = c;
        c.enqueue(this.chunk({ role: 'assistant', content: '' }));
        for (const b of this.queue.splice(0)) c.enqueue(b);
        this.lastSend = Date.now();
        // Dots while nothing real was sent for a while: only real chunks count as activity for the client.
        this.timer = setInterval(() => {
          if (Date.now() - this.lastSend >= HEARTBEAT_MS) this.think('.');
        }, 1000);
        void result
          .then((r) => this.pipe(r))
          .catch((e) => this.fail(e instanceof Error ? e.message : String(e)))
          .finally(() => {
            this.stop();
            try {
              c.close();
            } catch {
              /* the client already left */
            }
          });
      },
      cancel: () => this.leave(),
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'x-guardrail-request-id': this.id, 'x-opsara-request-id': this.id } });
  }

  private fail(message: string, type = 'api_error', code: string | number | null = null) {
    this.write(enc.encode(`data: ${JSON.stringify({ error: { message, type, code } })}\n\ndata: [DONE]\n\n`));
  }

  /** Send the request's own reply on: a stream goes through as it is, an error becomes an error event. */
  private async pipe(r: Response) {
    this.stop();
    const type = r.headers.get('content-type') ?? '';
    if (!r.body || !type.includes('text/event-stream')) {
      const text = r.body ? await r.text() : '';
      let message = text.slice(0, 500) || `The gateway answered ${r.status}.`;
      let t = 'api_error';
      let code: string | number | null = r.status;
      try {
        const e = (JSON.parse(text) as { error?: { message?: string; type?: string; code?: string | number } }).error;
        if (e?.message) message = e.message;
        if (e?.type) t = e.type;
        if (e?.code) code = e.code;
      } catch {
        /* not JSON: use the text */
      }
      return this.fail(message, t, code);
    }
    const reader = r.body.getReader();
    for (;;) {
      if (this.cancelled) return void reader.cancel().catch(() => {});
      const { value, done } = await reader.read();
      if (done) return;
      this.write(value);
    }
  }
}
