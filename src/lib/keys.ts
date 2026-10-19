import crypto from 'crypto';
import { getDb, now } from './db';
import { GroupSettings, SETTING_DEFS, SettingKey, StoredSetting, getGroup, normalizeSetting } from './groups';

export interface ApiKeyRow {
  id: number;
  name: string;
  owner: string;
  group_id: number;
  prefix: string;
  hash: string;
  exceptions: string;
  expires_at: number | null;
  revoked: number;
  last_used_at: number | null;
  created_at: number;
}

export interface ApiKey {
  id: number;
  name: string;
  owner: string;
  groupId: number;
  prefix: string;
  exceptions: GroupSettings;
  expiresAt: number | null;
  revoked: boolean;
  lastUsedAt: number | null;
  createdAt: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateSecret(): string {
  const bytes = crypto.randomBytes(32);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return `grk_live_${s}`;
}

export const hashKey = (secret: string) => crypto.createHash('sha256').update(secret).digest('hex');

function parse(r: ApiKeyRow): ApiKey {
  let exceptions: GroupSettings = {};
  try {
    exceptions = JSON.parse(r.exceptions);
  } catch {
    exceptions = {};
  }
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    groupId: r.group_id,
    prefix: r.prefix,
    exceptions,
    expiresAt: r.expires_at,
    revoked: !!r.revoked,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
  };
}

/** Exceptions may only add to lists or override numbers and text. */
export function cleanExceptions(input: unknown): GroupSettings {
  const out: GroupSettings = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input as Record<string, StoredSetting>)) {
    if (!SETTING_DEFS.some((d) => d.key === k) || !v || typeof v !== 'object') continue;
    out[k as SettingKey] = normalizeSetting(k as SettingKey, v, false);
  }
  return out;
}

export function createKey(input: { name: string; owner: string; groupId: number; exceptions?: unknown; expiresAt?: number | null }) {
  const name = input.name.trim();
  const owner = input.owner.trim();
  if (!owner) throw new Error('Say who the key is for.');
  if (!name) throw new Error('Give the key a name.');
  if (!getGroup(input.groupId)) throw new Error('Pick a group.');
  const secret = generateSecret();
  const r = getDb()
    .prepare(
      `INSERT INTO api_keys (name, owner, group_id, prefix, hash, exceptions, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, owner, input.groupId, secret.slice(0, 13), hashKey(secret), JSON.stringify(cleanExceptions(input.exceptions)), input.expiresAt ?? null, now());
  return { key: getKey(Number(r.lastInsertRowid))!, secret };
}

export function getKey(id: number): ApiKey | undefined {
  const r = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as ApiKeyRow | undefined;
  return r ? parse(r) : undefined;
}

export function listKeys(): ApiKey[] {
  return (getDb().prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as ApiKeyRow[]).map(parse);
}

export function updateKey(id: number, patch: { name?: string; owner?: string; groupId?: number; exceptions?: unknown; expiresAt?: number | null; revoked?: boolean }) {
  const k = getKey(id);
  if (!k) throw new Error('Key not found.');
  if (patch.groupId !== undefined && !getGroup(patch.groupId)) throw new Error('Group not found.');
  getDb()
    .prepare('UPDATE api_keys SET name = ?, owner = ?, group_id = ?, exceptions = ?, expires_at = ?, revoked = ? WHERE id = ?')
    .run(
      patch.name?.trim() || k.name,
      patch.owner?.trim() || k.owner,
      patch.groupId ?? k.groupId,
      JSON.stringify(patch.exceptions === undefined ? k.exceptions : cleanExceptions(patch.exceptions)),
      patch.expiresAt === undefined ? k.expiresAt : patch.expiresAt,
      (patch.revoked ?? k.revoked) ? 1 : 0,
      id,
    );
  return getKey(id)!;
}

export function deleteKey(id: number) {
  getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export type KeyLookup = { ok: true; key: ApiKey } | { ok: false; reason: string; key?: ApiKey };

export function lookupKey(secret: string | null): KeyLookup {
  if (!secret) return { ok: false, reason: 'No API key was sent.' };
  const r = getDb().prepare('SELECT * FROM api_keys WHERE hash = ?').get(hashKey(secret)) as ApiKeyRow | undefined;
  if (!r) return { ok: false, reason: 'The API key is not valid.' };
  const key = parse(r);
  if (key.revoked) return { ok: false, reason: 'The API key was revoked.', key };
  if (key.expiresAt && key.expiresAt < now()) return { ok: false, reason: 'The API key has expired.', key };
  return { ok: true, key };
}

export function touchKey(id: number) {
  getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), id);
}

export function requestsToday(): Map<number, number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = getDb()
    .prepare('SELECT key_id, COUNT(*) n FROM request_logs WHERE ts >= ? AND key_id IS NOT NULL GROUP BY key_id')
    .all(start.getTime()) as { key_id: number; n: number }[];
  return new Map(rows.map((r) => [r.key_id, r.n]));
}
