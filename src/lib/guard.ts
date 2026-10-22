import { getServer, errMsg } from './servers';
import type { GuardSettings } from './settings';

export interface Segment {
  source: 'user message' | 'tool result' | 'system prompt';
  text: string;
}

type Msg = { role?: string; content?: unknown; tool_call_id?: string };

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p && typeof (p as { text: unknown }).text === 'string' ? (p as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Agents resend the whole conversation every turn. Only what arrived since the
 * model last spoke is new, so that is all we scan.
 */
export function newSegments(messages: Msg[], scan: GuardSettings['scan']): Segment[] {
  const out: Segment[] = [];
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === 'assistant') lastAssistant = i;
  });
  if (scan.system) {
    for (const m of messages) if (m.role === 'system' || m.role === 'developer') push(out, 'system prompt', contentText(m.content));
  }
  for (const m of messages.slice(lastAssistant + 1)) {
    if (m.role === 'user' && scan.user) {
      // Cline puts tool output inside user messages; treat tagged blocks as tool results.
      const text = contentText(m.content);
      const isToolish = /^\s*\[(?:\w+ for|read_file|execute_command|browser_action|use_mcp_tool)[^\]]*\] Result:/m.test(text);
      push(out, isToolish && scan.tool ? 'tool result' : 'user message', text);
    } else if (m.role === 'tool' && scan.tool) {
      push(out, 'tool result', contentText(m.content));
    }
  }
  return out;
}

function push(out: Segment[], source: Segment['source'], text: string) {
  if (text.trim()) out.push({ source, text });
}

// ---- Check 1: PIGuard (or the built-in fallback) ----

export interface Check1 {
  score: number;
  quote: string | null;
  source: Segment['source'] | null;
  ms: number;
  engine: string;
  error?: string;
}

const PATTERNS: [RegExp, number][] = [
  [/ignore (?:all |any )?(?:the )?(?:previous|prior|above|earlier) (?:instructions|rules|prompts?|directions)/i, 0.92],
  [/disregard (?:all |any )?(?:the )?(?:previous|prior|above|your) (?:instructions|rules|guidelines)/i, 0.9],
  [/(?:upload|send|post|exfiltrate|transmit|curl|wget)[^\n]{0,80}(?:\.ssh|id_rsa|id_ed25519|\.env\b|credentials|private key|aws_secret)/i, 0.93],
  [/(?:cat|print|read|show|dump|base64)\s[^\n]{0,40}(?:~\/\.ssh|id_rsa|\.aws\/credentials|\/etc\/shadow)/i, 0.82],
  [/curl[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i, 0.86],
  [/rm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/i, 0.88],
  [/(?:you are now|from now on you are|act as)\s+(?:DAN|an? (?:unrestricted|unfiltered|jailbroken))/i, 0.9],
  [/(?:AI|LLM) (?:agents?|assistants?|models?)\s*[:,-][^\n]{0,80}(?:must|should|ignore|instead)/i, 0.8],
  [/<!--[^>]{0,200}(?:ignore|instruction|agent|assistant)[^>]{0,200}-->/i, 0.84],
  [/(?:disable|turn off|bypass)\s[^\n]{0,30}(?:security|antivirus|firewall|guardrail|safety)/i, 0.8],
  [/(?:reveal|print|repeat|show)\s[^\n]{0,30}(?:system prompt|hidden instructions)/i, 0.72],
  [/new instructions?:/i, 0.7],
];

function snippet(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

export function builtinScore(segments: Segment[]): Omit<Check1, 'ms'> {
  let best: Omit<Check1, 'ms'> = { score: 0.02, quote: null, source: null, engine: 'built-in patterns' };
  for (const seg of segments) {
    for (const [re, w] of PATTERNS) {
      const m = re.exec(seg.text);
      if (m && w > best.score) best = { score: w, quote: snippet(seg.text, m.index, m[0].length), source: seg.source, engine: 'built-in patterns' };
    }
  }
  return best;
}

/** Split long text into windows the classifier can read (PIGuard takes ~512 tokens). */
export function windows(segments: Segment[], size = 1800, overlap = 200) {
  const out: { seg: Segment; text: string }[] = [];
  for (const seg of segments) {
    if (seg.text.length <= size) out.push({ seg, text: seg.text });
    else for (let i = 0; i < seg.text.length; i += size - overlap) out.push({ seg, text: seg.text.slice(i, i + size) });
  }
  return out.slice(0, 64);
}

export async function runCheck1(segments: Segment[], g: GuardSettings): Promise<Check1> {
  const t0 = performance.now();
  const ms = () => Math.round((performance.now() - t0) * 10) / 10;
  if (!segments.length) return { score: 0, quote: null, source: null, ms: ms(), engine: 'nothing new to scan' };
  const server = g.piguard.mode === 'vllm' && g.piguard.serverId ? getServer(g.piguard.serverId) : undefined;
  if (!server) return { ...builtinScore(segments), ms: ms() };
  const wins = windows(segments);
  try {
    const res = await fetch(`${server.url}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(server.api_key ? { Authorization: `Bearer ${server.api_key}` } : {}) },
      body: JSON.stringify({ model: g.piguard.model, input: wins.map((w) => w.text) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`PIGuard answered ${res.status}`);
    const body = (await res.json()) as { data?: { probs?: number[]; label?: string }[] };
    let best = -1;
    let score = 0;
    (body.data ?? []).forEach((d, i) => {
      const p = Array.isArray(d.probs) ? Number(d.probs[g.piguard.labelIndex] ?? 0) : /inject|unsafe|malicious|^1$/i.test(String(d.label ?? '')) ? 1 : 0;
      if (p > score) {
        score = p;
        best = i;
      }
    });
    const w = wins[best];
    return { score: Math.round(score * 100) / 100, quote: w ? w.text.slice(0, 400) : null, source: w?.seg.source ?? null, ms: ms(), engine: `${g.piguard.model} on ${server.name}` };
  } catch (e) {
    // Fall back to the patterns rather than letting traffic through unscanned.
    return { ...builtinScore(segments), ms: ms(), error: `PIGuard unavailable (${errMsg(e)}); used built-in patterns` };
  }
}

// ---- Check 2: the OSS safeguard model ----

export interface Check2 {
  verdict: 'allow' | 'block';
  reason: string;
  reasoning: string | null;
  ms: number;
  error?: string;
}

const JSON_INSTRUCTION = '\n\nAnswer with JSON only, in this shape: {"verdict": "allow" or "block", "reason": "one short sentence"}';

export function parseVerdict(text: string): { verdict: 'allow' | 'block'; reason: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { verdict?: string; decision?: string; reason?: string };
      const v = String(j.verdict ?? j.decision ?? '').toLowerCase();
      if (v === 'allow' || v === 'block') return { verdict: v, reason: String(j.reason ?? '').trim() };
    } catch {
      // fall through to the word search
    }
  }
  const w = text.match(/\b(allow|block)\b/i);
  if (!w) return null;
  return { verdict: w[1].toLowerCase() as 'allow' | 'block', reason: text.replace(/\s+/g, ' ').trim().slice(0, 300) };
}

export function judgeInput(segments: Segment[], flagged: string | null) {
  const body = segments.map((s) => `[${s.source}]\n${s.text}`).join('\n\n').slice(-24000);
  return (flagged ? `The first check flagged this part:\n"""${flagged}"""\n\n` : '') + `New content in the request:\n"""\n${body}\n"""`;
}

export async function runCheck2(segments: Segment[], flagged: string | null, prompt: string, g: GuardSettings): Promise<Check2> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const server = g.oss.serverId ? getServer(g.oss.serverId) : undefined;
  if (!g.oss.enabled || !server) {
    const verdict = g.oss.onTimeout;
    const what = flagged ? 'Check 1 flagged it' : 'It needed the second check';
    return { verdict, reason: verdict === 'block' ? `${what} and no second check is set up.` : `${what}; no second check is set up, so it was let through.`, reasoning: null, ms: ms(), error: g.oss.enabled ? 'No OSS check server configured' : 'The second check is off' };
  }
  try {
    const res = await fetch(`${server.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(server.api_key ? { Authorization: `Bearer ${server.api_key}` } : {}) },
      body: JSON.stringify({
        model: g.oss.model,
        messages: [
          { role: 'system', content: prompt + JSON_INSTRUCTION },
          { role: 'user', content: judgeInput(segments, flagged) },
        ],
        temperature: 0,
        max_tokens: 1024,
        reasoning_effort: g.oss.reasoningEffort,
        stream: false,
      }),
      signal: AbortSignal.timeout(g.oss.timeoutMs),
    });
    if (!res.ok) throw new Error(`OSS check answered ${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string; reasoning_content?: string; reasoning?: string } }[] };
    const msg = body.choices?.[0]?.message ?? {};
    const parsed = parseVerdict(msg.content ?? '');
    if (!parsed) throw new Error('OSS check gave no clear allow or block');
    return { ...parsed, reason: parsed.reason || (parsed.verdict === 'block' ? 'Judged unsafe.' : 'Judged safe.'), reasoning: msg.reasoning_content ?? msg.reasoning ?? null, ms: ms() };
  } catch (e) {
    const verdict = g.oss.onTimeout;
    const why = errMsg(e);
    return { verdict, reason: verdict === 'block' ? `The second check failed (${why}), so the request was blocked to be safe.` : `The second check failed (${why}); let through by setting.`, reasoning: null, ms: ms(), error: why };
  }
}

// ---- Blocked reply ----

export function renderBlocked(template: string, reason: string, requestId: string, includeReason: boolean) {
  let t = template.replace(/\{request_id\}/g, requestId);
  if (includeReason) t = t.replace(/\{reason\}/g, reason);
  else t = t.split('\n').filter((l) => !l.includes('{reason}')).join('\n');
  return t;
}
