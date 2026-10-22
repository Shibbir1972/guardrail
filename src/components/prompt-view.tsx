'use client';

import { useState } from 'react';
import type { PromptMessage } from '@/lib/logs';
import { fmt, useToast } from './ui';

/** Long messages start folded so a 50-file agent prompt stays scannable. */
const FOLD_AT = 1200;

const ROLE_CLS: Record<string, string> = { system: 'info', developer: 'info', user: 'ok', assistant: '', tool: 'warn', function: 'warn' };

export function messageText(m: PromptMessage): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : JSON.stringify(p)))
      .join('\n');
  return c === undefined || c === null ? '' : JSON.stringify(c, null, 2);
}

// Fields besides role and content worth showing, such as tool_calls or tool_call_id.
const extras = (m: PromptMessage) => Object.fromEntries(Object.entries(m).filter(([k, v]) => k !== 'role' && k !== 'content' && v !== undefined && v !== null));

export type Mark = 'added' | 'changed';

/**
 * Which messages GuardRail added or changed on the way to the model,
 * by comparing what was sent with what the client sent.
 */
export function diffMarks(sent: PromptMessage[], original: PromptMessage[] | null | undefined): (Mark | null)[] {
  if (!original) return sent.map(() => null);
  const seen = new Set(original.map((m) => JSON.stringify(m)));
  // Context at the top shifts everything down by one.
  const offset = sent.length - original.length;
  return sent.map((m, i) => {
    if (seen.has(JSON.stringify(m))) return null;
    const o = original[i - offset] ?? original[i];
    return o && o.role === m.role ? 'changed' : 'added';
  });
}

export function PromptView({ messages, marks, empty }: { messages: PromptMessage[] | null | undefined; marks?: (Mark | null)[]; empty: string }) {
  const toast = useToast();
  if (!messages?.length) return <div className="note">{empty}</div>;
  const chars = messages.reduce((a, m) => a + messageText(m).length, 0);
  const copy = () =>
    navigator.clipboard.writeText(JSON.stringify(messages, null, 2)).then(
      () => toast('Copied as JSON'),
      () => toast('Could not copy', true),
    );
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="between">
        <span className="muted small">
          {messages.length} {messages.length === 1 ? 'message' : 'messages'} · {fmt(chars)} characters
        </span>
        <button type="button" className="btn sm" onClick={copy}>
          Copy JSON
        </button>
      </div>
      {messages.map((m, i) => (
        <Message key={i} m={m} n={i + 1} mark={marks?.[i] ?? null} />
      ))}
    </div>
  );
}

function Message({ m, n, mark }: { m: PromptMessage; n: number; mark: Mark | null }) {
  const text = messageText(m);
  const [open, setOpen] = useState(text.length <= FOLD_AT);
  const more = extras(m);
  const role = m.role ?? 'unknown';
  return (
    <div className={`pmsg${mark ? ' mark' : ''}`}>
      <div className="between" style={{ flexWrap: 'nowrap' }}>
        <span className="wrap" style={{ gap: 6 }}>
          <span className="mono muted">{n}.</span>
          <span className={`pill ${ROLE_CLS[role] ?? ''}`}>{role}</span>
          {typeof m.name === 'string' && <span className="mono muted">{m.name}</span>}
          {mark && <span className="pill info">{mark === 'added' ? 'Added by GuardRail' : 'Changed by GuardRail'}</span>}
        </span>
        <span className="mono muted" style={{ whiteSpace: 'nowrap' }}>{fmt(text.length)} chars</span>
      </div>
      {text && (
        <div className="ptext" style={open ? undefined : { maxHeight: 140, overflow: 'hidden' }}>
          {text}
        </div>
      )}
      {text.length > FOLD_AT && (
        <button type="button" className="linkbtn" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
      {Object.keys(more).length > 0 && <pre className="why mono" style={{ margin: 0, overflow: 'auto' }}>{JSON.stringify(more, null, 2)}</pre>}
    </div>
  );
}
