/**
 * Copy the secrets the tick needs from .env.local into GitHub Actions secrets.
 *   pnpm secrets:gh          set them
 *   pnpm secrets:gh --check  list which of them the repo already has
 *
 * Values are piped over stdin, never placed in argv (argv is visible in the
 * process list) and never printed. Only the key name and its length are shown,
 * which is enough to catch a truncated paste without leaking the value.
 *
 * NODE_TLS_REJECT_UNAUTHORIZED is deliberately not in the list: it is a local
 * workaround for this machine's cert chain and must never be set in CI.
 */
import '../lib/env.mjs';
import { spawnSync } from 'node:child_process';

const REPO = 'Sagik555/better-me';

const KEYS = [
  'OURA_CLIENT_ID', 'OURA_CLIENT_SECRET', 'OURA_REDIRECT_URI',
  'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN',
  'GEMINI_API_KEY',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
  'MY_EMAIL',
];

if (process.argv.includes('--check')) {
  const r = spawnSync('gh', ['secret', 'list', '--repo', REPO], { encoding: 'utf8', shell: true });
  if (r.status !== 0) {
    console.error(r.stderr || 'gh secret list failed');
    process.exit(1);
  }
  const have = new Set(r.stdout.split(/\r?\n/).map((l) => l.split(/\s+/)[0]).filter(Boolean));
  for (const key of KEYS) console.log(`  ${key.padEnd(22)} ${have.has(key) ? 'present' : 'MISSING'}`);
  process.exit(0);
}

let ok = 0;
for (const key of KEYS) {
  const value = process.env[key];
  if (!value) {
    console.log(`  ${key.padEnd(22)} MISSING in .env.local, skipped`);
    continue;
  }
  const r = spawnSync('gh', ['secret', 'set', key, '--repo', REPO], {
    input: value, encoding: 'utf8', shell: true,
  });
  const status = r.status === 0 ? 'set' : `FAILED ${(r.stderr || '').trim().slice(0, 100)}`;
  console.log(`  ${key.padEnd(22)} ${status}  (${value.length} chars)`);
  if (r.status === 0) ok += 1;
}
console.log(`\n${ok}/${KEYS.length} secrets set on ${REPO}.`);
