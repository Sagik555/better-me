/**
 * One-time Oura OAuth2 consent.
 *
 * Run once on this machine:  pnpm oura:consent
 *
 * Opens a browser to Oura's consent screen, catches the redirect on
 * localhost:3000, exchanges the code for tokens, and stores them in Turso.
 * Production never runs this: it only ever refreshes an existing token, which
 * hits the token endpoint and redirects nowhere.
 *
 * The `scope` parameter is deliberately OMITTED. The application was registered
 * with all 12 scopes ticked, but only 8 are documented and the docs disagree with
 * the OpenAPI spec on at least one name (`spo2` vs `spo2Daily`). Sending an
 * unknown scope string would reject the whole authorization request, so we let
 * Oura grant the application's own registered set. Pass --scope="a b c" to
 * override if a resource later returns 403.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import '../lib/env.mjs';
import { AUTHORIZE_URL, db, ensureAuthTable, exchangeCode, storeTokens } from '../lib/oura-auth.mjs';

const REDIRECT_URI = process.env.OURA_REDIRECT_URI || 'http://localhost:3000/api/oura/callback';
const PORT = Number(new URL(REDIRECT_URI).port || 3000);
const CALLBACK_PATH = new URL(REDIRECT_URI).pathname;

const scopeArg = process.argv.find((a) => a.startsWith('--scope='));
const scope = scopeArg ? scopeArg.slice('--scope='.length) : null;

for (const k of ['OURA_CLIENT_ID', 'OURA_CLIENT_SECRET', 'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']) {
  if (!process.env[k]) {
    console.error(`Missing ${k} in .env.local`);
    process.exit(1);
  }
}

const state = crypto.randomBytes(16).toString('hex');
const authUrl = new URL(AUTHORIZE_URL);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', process.env.OURA_CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('state', state);
if (scope) authUrl.searchParams.set('scope', scope);

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px/1.6 system-ui;max-width:34rem;margin:12vh auto;padding:0 1.5rem">` +
  `<h1 style="font-size:1.4rem">${title}</h1>${body}</body>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404).end('not found');
    return;
  }

  const err = url.searchParams.get('error');
  if (err) {
    const desc = url.searchParams.get('error_description') || '';
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Authorization failed', `<p><code>${err}</code></p><p>${desc}</p>`));
    console.error(`\nAuthorization failed: ${err} ${desc}`);
    server.close();
    process.exit(1);
  }

  if (url.searchParams.get('state') !== state) {
    res.writeHead(400).end('state mismatch');
    console.error('\nState mismatch. Aborting.');
    server.close();
    process.exit(1);
  }

  try {
    const tok = await exchangeCode(url.searchParams.get('code'), REDIRECT_URI);
    const client = db();
    await ensureAuthTable(client);
    const expiresAt = await storeTokens(client, tok);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Connected', '<p>Oura is connected. You can close this tab and go back to the terminal.</p>'));

    console.log('\nTokens stored in Turso (oura_auth).');
    console.log(`  granted scopes : ${tok.scope ?? '(not reported)'}`);
    console.log(`  access expires : ${expiresAt}`);
    console.log(`  refresh token  : stored (single-use, rotates on every refresh)`);
    console.log('\nNext: pnpm oura:probe-workouts');
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page('Token exchange failed', `<pre>${e.message}</pre>`));
    console.error(`\n${e.message}`);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log(`\nOpening the Oura consent screen. If it does not open, paste this:\n\n${authUrl}\n`);
  exec(`start "" "${authUrl}"`, { shell: 'cmd.exe' }, () => {});
});
