/**
 * Oura OAuth2 token storage and refresh.
 *
 * CRITICAL: Oura refresh tokens are SINGLE USE. Every refresh returns a new
 * refresh_token and invalidates the one you just spent. If a refresh response is
 * not persisted, the account is locked out and the only recovery is running the
 * browser consent flow again by hand.
 *
 * Two callers refreshing at once is therefore a real failure mode (a local
 * backfill script running while the 06:00 cron fires). The write below is a
 * compare-and-swap: it only updates the row if the refresh_token is still the one
 * we spent. A zero-row result means someone else refreshed first, so we re-read
 * their result instead of clobbering it.
 */
import { createClient } from '@libsql/client';
import './env.mjs';

export const AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const TOKEN_URL = 'https://api.ouraring.com/oauth/token';
export const API_BASE = 'https://api.ouraring.com/v2/usercollection';

/** Refresh this many seconds before the token actually expires. */
const EXPIRY_MARGIN_SEC = 300;

export function db() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export async function ensureAuthTable(client) {
  await client.execute({
    sql: `CREATE TABLE IF NOT EXISTS oura_auth (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      access_token  TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at    TEXT NOT NULL,
      scope         TEXT,
      updated_at    TEXT NOT NULL
    )`,
    args: [],
  });
}

/** Exchange an authorization code (or a refresh token) for a token pair. */
async function tokenRequest(params) {
  const body = new URLSearchParams({
    ...params,
    client_id: process.env.OURA_CLIENT_ID,
    client_secret: process.env.OURA_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Oura token endpoint ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

export async function exchangeCode(code, redirectUri) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
}

export async function storeTokens(client, tok) {
  const expiresAt = new Date(Date.now() + (tok.expires_in ?? 86400) * 1000).toISOString();
  await client.execute({
    sql: `INSERT INTO oura_auth (id, access_token, refresh_token, expires_at, scope, updated_at)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at,
            scope = excluded.scope,
            updated_at = excluded.updated_at`,
    args: [tok.access_token, tok.refresh_token, expiresAt, tok.scope ?? null, new Date().toISOString()],
  });
  return expiresAt;
}

/**
 * Return a valid access token, refreshing if it is close to expiry.
 * Safe to call concurrently: the refresh write is a compare-and-swap.
 */
export async function getAccessToken(client) {
  const { rows } = await client.execute({ sql: 'SELECT * FROM oura_auth WHERE id = 1', args: [] });
  if (!rows.length) {
    throw new Error('No Oura tokens stored. Run: pnpm oura:consent');
  }
  const row = rows[0];
  const expiresMs = Date.parse(row.expires_at);
  if (Date.now() < expiresMs - EXPIRY_MARGIN_SEC * 1000) {
    return row.access_token;
  }

  const spent = row.refresh_token;
  const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: spent });
  const expiresAt = new Date(Date.now() + (tok.expires_in ?? 86400) * 1000).toISOString();

  // Compare-and-swap: only write if nobody else has refreshed since we read.
  const res = await client.execute({
    sql: `UPDATE oura_auth
             SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ?
           WHERE id = 1 AND refresh_token = ?`,
    args: [tok.access_token, tok.refresh_token, expiresAt, new Date().toISOString(), spent],
  });

  if (res.rowsAffected === 0) {
    // Another process refreshed first and its token is the live one. Use theirs.
    const again = await client.execute({ sql: 'SELECT access_token FROM oura_auth WHERE id = 1', args: [] });
    return again.rows[0].access_token;
  }
  return tok.access_token;
}

/**
 * GET an Oura collection, following next_token to exhaustion.
 * The spec's ingest ignored pagination; a 200-day backfill of sleep or workout
 * silently returns a truncated first page without it.
 */
export async function ouraGet(accessToken, resource, params = {}) {
  const out = [];
  let nextToken = null;
  let calls = 0;
  do {
    const qs = new URLSearchParams(params);
    if (nextToken) qs.set('next_token', nextToken);
    const res = await fetch(`${API_BASE}/${resource}?${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    calls += 1;
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Oura ${resource} ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      err.rateLimit = {
        limit: res.headers.get('x-ratelimit-limit'),
        remaining: res.headers.get('x-ratelimit-remaining'),
        retryAfter: res.headers.get('retry-after'),
      };
      throw err;
    }
    const json = await res.json();
    if (Array.isArray(json.data)) out.push(...json.data);
    else out.push(json);
    nextToken = json.next_token ?? null;
  } while (nextToken);
  return { data: out, calls };
}
