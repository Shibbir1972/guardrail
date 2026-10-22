import fs from 'fs';
import path from 'path';
import type { LogEntry, PromptMessage, Step } from './logs';

/**
 * Full prompts live on disk, one Markdown file per request, so the database
 * stays small and an admin can open a turn in any editor. The log row keeps
 * only the file's path, relative to promptsDir().
 */

export function promptsDir(): string {
  return process.env.GUARDRAIL_PROMPTS_DIR || path.join(process.cwd(), 'data', 'prompts');
}

/** How long prompt files are kept. The log rows themselves stay. */
export function retentionDays(): number {
  const n = Number(process.env.GUARDRAIL_PROMPT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

// One folder per UTC day: data/prompts/2026-10-22/req_ab12cd34ef56.md
export const relPathFor = (id: string, ts: number) => `${new Date(ts).toISOString().slice(0, 10)}/${id}.md`;

/** Resolve a stored path, refusing anything that points outside the prompts folder. */
function resolve(rel: string): string | null {
  const root = path.resolve(promptsDir());
  const full = path.resolve(root, rel);
  return full.startsWith(root + path.sep) ? full : null;
}

type FileEntry = Pick<LogEntry, 'id' | 'ts' | 'owner' | 'key_name' | 'group_name' | 'ip' | 'path' | 'schema' | 'model' | 'server' | 'outcome' | 'status_code' | 'reason' | 'c1_score' | 'c1_status' | 'c2_status' | 'c2_reason'> & {
  steps?: Step[];
  prompt?: PromptMessage[] | null;
  forwarded?: PromptMessage[] | null;
};

// ---- writing ----

/** A fence longer than any run of backticks inside the text, so content can never close it early. */
function fence(text: string) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

const block = (lang: string, text: string) => {
  const f = fence(text);
  return `${f}${lang}\n${text}\n${f}`;
};

function renderMessages(title: string, messages: PromptMessage[] | null | undefined, none: string) {
  const out = [`## ${title}`, ''];
  if (!messages) return [...out, none, ''].join('\n');
  messages.forEach((m, i) => {
    out.push(`### ${i + 1} · ${m.role ?? 'unknown'}`, '');
    // Plain text goes in a text block people can read; anything else (multi-part
    // content, tool calls, names) goes in a JSON block so it comes back exactly.
    const { content } = m;
    const fields: Record<string, unknown> = Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'role' && k !== 'content'));
    if (typeof content === 'string') out.push(block('text', content), '');
    else if (content !== undefined && content !== null) fields.content = content;
    if (Object.keys(fields).length) out.push(block('json fields', JSON.stringify(fields, null, 2)), '');
  });
  return out.join('\n');
}

const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderPromptFile(e: FileEntry): string {
  const rows: [string, unknown][] = [
    ['Time', new Date(e.ts).toISOString()],
    ['Key', e.key_name ? `${e.key_name} (${e.owner ?? 'unknown'})` : null],
    ['Group', e.group_name],
    ['IP', e.ip],
    ['Endpoint', e.path],
    ['Schema', e.schema],
    ['Model', e.model],
    ['Server', e.server],
    ['Check 1 · PIGuard', e.c1_status ? `${e.c1_status}${e.c1_score !== null && e.c1_score !== undefined ? ` (${e.c1_score.toFixed(2)})` : ''}` : null],
    ['Check 2 · OSS', e.c2_status ? `${e.c2_status}${e.c2_reason ? `: ${e.c2_reason}` : ''}` : null],
    ['Outcome', `${e.outcome}${e.status_code ? ` (${e.status_code})` : ''}`],
    ['Reason', e.reason],
  ];
  const steps = (e.steps ?? []).map((s, i) => `${i + 1}. **${s.head}** (${s.ms} ms). ${s.text}${s.quote ? `\n\n${block('text', s.quote).replace(/^/gm, '   ')}` : ''}`);
  return [
    `# Request ${e.id}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `| ${k} | ${cell(v)} |`),
    '',
    renderMessages('Prompt', e.prompt, 'No prompt was read from this request.'),
    renderMessages('Sent to model', e.forwarded, 'Nothing was sent to the model.'),
    '## What GuardRail did',
    '',
    steps.length ? steps.join('\n') : 'No steps were recorded.',
    '',
  ].join('\n');
}

/** Write (or rewrite) the file for a request. Returns its stored path, or null if it could not be written. */
export function writePromptFile(e: FileEntry, rel = relPathFor(e.id, e.ts)): string | null {
  const full = resolve(rel);
  if (!full) return null;
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, renderPromptFile(e));
    return rel;
  } catch (err) {
    // A full or read-only disk must never fail the request itself.
    console.error(`GuardRail: could not write prompt file ${full}:`, err);
    return null;
  }
}

// ---- reading ----

export function parsePromptFile(md: string): { prompt: PromptMessage[] | null; forwarded: PromptMessage[] | null } {
  const result: { prompt: PromptMessage[] | null; forwarded: PromptMessage[] | null } = { prompt: null, forwarded: null };
  const lines = md.split('\n');
  let section: 'prompt' | 'forwarded' | null = null;
  let msg: PromptMessage | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) {
      section = line === '## Prompt' ? 'prompt' : line === '## Sent to model' ? 'forwarded' : null;
      msg = null;
      continue;
    }
    if (!section) continue;
    const head = line.match(/^### \d+ · (.+)$/);
    if (head) {
      msg = head[1] === 'unknown' ? {} : { role: head[1] };
      (result[section] ??= []).push(msg);
      continue;
    }
    const open = line.match(/^(`{3,})(text|json fields)$/);
    if (open && msg) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i] !== open[1]; i++) body.push(lines[i]);
      const text = body.join('\n');
      if (open[2] === 'text') msg.content = text;
      else {
        try {
          Object.assign(msg, JSON.parse(text));
        } catch {
          // A hand-edited file; keep what parsed.
        }
      }
    }
  }
  return result;
}

export function readPromptFile(rel: string): { prompt: PromptMessage[] | null; forwarded: PromptMessage[] | null } | null {
  const full = resolve(rel);
  if (!full) return null;
  try {
    return parsePromptFile(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

// ---- retention ----

/** Delete prompt files older than the retention period and remove day folders left empty. Returns how many files went. */
export function prunePromptFiles(at = Date.now()): number {
  const root = promptsDir();
  const cutoff = at - retentionDays() * 86400_000;
  let removed = 0;
  let days: string[];
  try {
    days = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const day of days) {
    const dir = path.join(root, day);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        if (f.endsWith('.md') && fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // Already gone.
      }
    }
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch {
      // Not empty or already gone.
    }
  }
  return removed;
}
