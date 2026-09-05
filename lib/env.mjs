/**
 * Loads .env.local (the file this project actually uses) before .env.
 * `import 'dotenv/config'` only reads .env and would silently find nothing.
 * Import this instead, first, in every script and server entry point.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

config({ path: path.join(root, '.env.local'), quiet: true });
config({ path: path.join(root, '.env'), quiet: true });

export function requireEnv(...keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing in .env.local: ${missing.join(', ')}`);
  }
}
