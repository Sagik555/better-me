/**
 * Migration runner.  pnpm db:migrate
 *
 * libSQL's execute() takes ONE statement at a time and chokes on `--` line
 * comments, so each file is stripped of comments and split on `;` before being
 * applied statement by statement. Applied filenames are recorded so reruns are
 * no-ops.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../lib/env.mjs';
import { db } from '../lib/oura-auth.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'db', 'migrations');
const client = db();

await client.execute({
  sql: `CREATE TABLE IF NOT EXISTS _migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        )`,
  args: [],
});

const { rows } = await client.execute({ sql: 'SELECT name FROM _migrations', args: [] });
const done = new Set(rows.map((r) => r.name));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

let applied = 0;
for (const file of files) {
  if (done.has(file)) {
    console.log(`  skip  ${file}`);
    continue;
  }
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  const statements = raw
    .split(/\r?\n/)
    .filter((l) => !/^\s*--/.test(l))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const sql of statements) {
    await client.execute({ sql, args: [] });
  }
  await client.execute({
    sql: 'INSERT INTO _migrations (name, applied_at) VALUES (?, ?)',
    args: [file, new Date().toISOString()],
  });
  console.log(`  apply ${file}  (${statements.length} statements)`);
  applied += 1;
}

console.log(applied ? `\n${applied} migration(s) applied.` : '\nUp to date.');

const t = await client.execute({
  sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  args: [],
});
console.log(`tables: ${t.rows.map((r) => r.name).join(', ')}`);
