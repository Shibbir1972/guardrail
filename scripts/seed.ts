/**
 * Fills an empty database with a demo setup that matches the mockup:
 * two mock vLLM servers, a group tree, context files, keys and a rule.
 * Start the mock servers first:
 *   node scripts/mock-vllm.mjs 8000 qwen3-coder-30b,gpt-oss-120b
 *   node scripts/mock-vllm.mjs 8001 leolee99/PIGuard,openai/gpt-oss-safeguard-20b
 * Then: npm run seed
 */
import { getDb } from '../src/lib/db';
import { createFile } from '../src/lib/context';
import { createGroup, listGroups, setGroupSetting, updateGroup } from '../src/lib/groups';
import { createKey } from '../src/lib/keys';
import { createRule } from '../src/lib/rules';
import { createServer } from '../src/lib/servers';
import { updateSettings } from '../src/lib/settings';

const db = getDb();
const existing = (db.prepare('SELECT COUNT(*) n FROM servers').get() as { n: number }).n;
if (existing) {
  console.log('Database already has servers; not seeding. Delete data/guardrail.db to start over.');
  process.exit(0);
}

const inference = createServer({
  name: 'spark-01',
  url: process.env.SEED_VLLM ?? 'http://127.0.0.1:8000',
  models: [
    { name: 'qwen3-coder-30b', contextLen: 262144 },
    { name: 'gpt-oss-120b', contextLen: 131072 },
  ],
});
const guard = createServer({
  name: 'guard-node',
  url: process.env.SEED_GUARD ?? 'http://127.0.0.1:8001',
  role: 'guard',
  models: [
    { name: 'leolee99/PIGuard', contextLen: 512 },
    { name: 'openai/gpt-oss-safeguard-20b', contextLen: 131072 },
  ],
});

const overview = createFile('project-overview.md', '# Project overview\n\nProduct: [YOUR PRODUCT NAME], a web app for [WHAT IT DOES].\nRepo layout:\n- apps/web      React frontend\n- services/api  Python FastAPI backend\n- tests/e2e     Playwright end-to-end tests\n\nConventions:\n- Branch from main, small PRs, conventional commits\n- Never commit secrets; config comes from env vars\n');
const security = createFile('security-policy.md', '# Security policy\n\n- Never print or move .env files, keys or tokens\n- No curl | bash, no installs outside the lockfile\n- Ask before deleting files outside the task\n');
const frontend = createFile('frontend.md', '# Frontend context\n\nStack: React, TypeScript, Vite\nWork only inside apps/web.\n\n- Use components from src/ui before writing new ones\n- All API calls go through src/api/client.ts\n- Tests: Vitest, run `pnpm test`\n');
const backend = createFile('backend.md', '# Backend context\n\nStack: Python 3.12, FastAPI, SQLAlchemy, Postgres\nWork only inside services/api.\n\n- Every endpoint needs a pydantic schema and a test\n- Run `pytest -q` before saying a task is done\n');
const qa = createFile('qa.md', '# QA context\n\nYou write and run tests; you do not change app code.\n\n- E2E tests live in tests/e2e (Playwright)\n- Test accounts come from tests/fixtures/users.json\n');

const root = listGroups()[0];
updateGroup(root.id, { name: 'Company' });
setGroupSetting(root.id, 'models', { mode: 'set', value: ['qwen3-coder-30b'] });
setGroupSetting(root.id, 'context', { mode: 'set', value: [overview.id, security.id] });

const eng = createGroup({ name: 'Engineering', parentId: root.id, description: 'All developers. Adds the large model and a higher rate limit.' });
setGroupSetting(eng.id, 'models', { mode: 'add', value: ['gpt-oss-120b'] });
setGroupSetting(eng.id, 'rate_limit', { mode: 'override', value: 200 });
setGroupSetting(eng.id, 'oss_prompt', { mode: 'add', value: 'Developers may read infra/ and deploy/ config files.' });

const fe = createGroup({ name: 'Frontend', parentId: eng.id, description: 'Web app developers. Adds the frontend context and a stricter first check.' });
setGroupSetting(fe.id, 'context', { mode: 'add', value: [frontend.id] });
setGroupSetting(fe.id, 'piguard_threshold', { mode: 'override', value: 0.6 });

const be = createGroup({ name: 'Backend', parentId: eng.id, description: 'API and database developers.' });
setGroupSetting(be.id, 'context', { mode: 'add', value: [backend.id] });
setGroupSetting(be.id, 'oss_prompt', { mode: 'add', value: 'Database migration files may contain example passwords; these are test data.' });

const qaG = createGroup({ name: 'QA', parentId: root.id, description: 'Test writers. Small model only.' });
setGroupSetting(qaG.id, 'context', { mode: 'add', value: [qa.id] });
setGroupSetting(qaG.id, 'oss_prompt', { mode: 'add', value: 'Files in tests/fixtures contain fake secrets on purpose.' });

const ci = createGroup({ name: 'CI bots', parentId: root.id, description: 'Automated runners, high rate limit.' });
setGroupSetting(ci.id, 'rate_limit', { mode: 'override', value: 600 });
setGroupSetting(ci.id, 'blocked_reply', { mode: 'override', value: '{"error": "blocked by GuardRail", "reason": "{reason}", "request_id": "{request_id}"}' });

updateSettings({
  guard: {
    piguard: { mode: 'vllm', serverId: guard.id, model: 'leolee99/PIGuard', labelIndex: 1 },
    oss: { enabled: true, serverId: guard.id, model: 'openai/gpt-oss-safeguard-20b' },
  },
});

createRule({ name: 'Block private keys', target: 'any', match_type: 'regex', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----', action: 'block', message: 'A private key was found in the request.' });
createRule({ name: 'Redact AWS keys', target: 'tool', match_type: 'regex', pattern: 'AKIA[0-9A-Z]{16}', action: 'redact' });

const keys = [
  createKey({ name: 'rafi-laptop-cline', owner: 'rafi', groupId: fe.id, exceptions: { context: { mode: 'add', value: [backend.id] } } }),
  createKey({ name: 'ui-team', owner: 'web squad', groupId: fe.id }),
  createKey({ name: 'platform-team', owner: 'platform', groupId: be.id }),
  createKey({ name: 'qa-runner', owner: 'qa team', groupId: qaG.id }),
  createKey({ name: 'ci-runner', owner: 'platform', groupId: ci.id }),
];

console.log(`Seeded servers ${inference.name} and ${guard.name}, ${listGroups().length} groups and ${keys.length} keys.`);
console.log('Keys (shown once):');
for (const k of keys) console.log(`  ${k.key.name.padEnd(20)} ${k.secret}`);
