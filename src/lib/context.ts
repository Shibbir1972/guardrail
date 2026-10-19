import { getDb, now } from './db';

export interface ContextFile {
  id: number;
  name: string;
  body: string;
  version: number;
  updated_at: number;
}

/** Rough count; good enough to show size and spot a file that is too big. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export function listFiles(): ContextFile[] {
  return getDb().prepare('SELECT * FROM context_files ORDER BY name').all() as ContextFile[];
}

export function getFile(id: number): ContextFile | undefined {
  return getDb().prepare('SELECT * FROM context_files WHERE id = ?').get(id) as ContextFile | undefined;
}

export function filesByIds(ids: number[]): ContextFile[] {
  const all = new Map(listFiles().map((f) => [f.id, f]));
  return ids.map((id) => all.get(id)).filter((f): f is ContextFile => !!f);
}

function cleanName(name: string) {
  const n = name.trim().replace(/[\\/]/g, '-');
  if (!n) throw new Error('Give the file a name.');
  return n.endsWith('.md') ? n : `${n}.md`;
}

export function createFile(name: string, body: string): ContextFile {
  const db = getDb();
  const n = cleanName(name);
  try {
    const r = db.prepare('INSERT INTO context_files (name, body, version, updated_at) VALUES (?, ?, 1, ?)').run(n, body, now());
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO context_file_versions (file_id, version, body, created_at) VALUES (?, 1, ?, ?)').run(id, body, now());
    return getFile(id)!;
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw new Error(`A file named ${n} already exists.`);
    throw e;
  }
}

/** Saving new text starts a new version; renaming alone does not. */
export function updateFile(id: number, patch: { name?: string; body?: string }): ContextFile {
  const db = getDb();
  const f = getFile(id);
  if (!f) throw new Error('File not found.');
  const name = patch.name ? cleanName(patch.name) : f.name;
  const changed = patch.body !== undefined && patch.body !== f.body;
  const version = changed ? f.version + 1 : f.version;
  db.transaction(() => {
    db.prepare('UPDATE context_files SET name = ?, body = ?, version = ?, updated_at = ? WHERE id = ?').run(name, changed ? patch.body : f.body, version, now(), id);
    if (changed) db.prepare('INSERT INTO context_file_versions (file_id, version, body, created_at) VALUES (?, ?, ?, ?)').run(id, version, patch.body, now());
  })();
  return getFile(id)!;
}

export function deleteFile(id: number) {
  getDb().prepare('DELETE FROM context_files WHERE id = ?').run(id);
}

export function fileHistory(id: number) {
  return getDb()
    .prepare('SELECT version, body, created_at FROM context_file_versions WHERE file_id = ? ORDER BY version DESC LIMIT 50')
    .all(id) as { version: number; body: string; created_at: number }[];
}

/**
 * The text GuardRail puts in front of a request. It must be byte-identical for every
 * request with the same settings so vLLM's prefix cache can reuse it.
 */
export function buildContextBlock(policyPrompt: string, files: ContextFile[]): string {
  const parts: string[] = [];
  if (policyPrompt.trim()) parts.push(policyPrompt.trim());
  for (const f of files) parts.push(`<project_context file="${f.name}">\n${f.body.trim()}\n</project_context>`);
  return parts.join('\n\n');
}
