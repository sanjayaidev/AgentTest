// lib/canva.js
//
// OAuth 2.0 + PKCE against the Canva Connect API (api.canva.com /
// www.canva.com/api/oauth/*) — this is a DIFFERENT surface from Canva's
// MCP server (mcp.canva.com). The Connect API is self-service: create an
// integration at https://www.canva.com/developers/integrations, set a
// redirect URI yourself, and you're authorizing users immediately — no
// waitlist/allowlist approval required (unlike MCP).

const crypto = require('crypto');
const { getTokens, saveTokens } = require('./tokenStore');

const AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
const TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const API_BASE = 'https://api.canva.com/rest/v1';

function basicAuthHeader() {
  const credentials = `${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

// In-memory, short-lived (10 min) state -> { verifier, sessionId }.
// Fine for a single Node process; if you ever run multiple instances
// behind a load balancer, move this to Redis/DB like the token store.
const pendingAuth = new Map();

function stashPendingAuth(state, verifier, sessionId) {
  pendingAuth.set(state, { verifier, sessionId, expiresAt: Date.now() + 10 * 60 * 1000 });
  // Opportunistic cleanup of stale entries.
  for (const [key, val] of pendingAuth) {
    if (val.expiresAt < Date.now()) pendingAuth.delete(key);
  }
}

function consumePendingAuth(state) {
  const entry = pendingAuth.get(state);
  if (!entry) return null;
  pendingAuth.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

function buildAuthorizeUrl({ state, codeChallenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.CANVA_CLIENT_ID);
  url.searchParams.set('redirect_uri', process.env.CANVA_REDIRECT_URI);
  url.searchParams.set('scope', process.env.CANVA_SCOPES || 'design:content:read design:content:write asset:read asset:write');
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 's256');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: process.env.CANVA_REDIRECT_URI,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const tokens = await resp.json();
  tokens.obtained_at = Date.now();
  return tokens;
}

async function refreshTokens(refreshToken) {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  const tokens = await resp.json();
  tokens.obtained_at = Date.now();
  return tokens;
}

// Returns a usable access token for this session, refreshing first if
// it's expired or close to it. Returns null if never connected.
async function getValidAccessToken(sessionId) {
  let tokens = getTokens(sessionId);
  if (!tokens) return null;

  const expiresAtMs = tokens.obtained_at + (tokens.expires_in || 14400) * 1000;
  if (Date.now() > expiresAtMs - 60_000) {
    if (!tokens.refresh_token) return null;
    tokens = await refreshTokens(tokens.refresh_token);
    saveTokens(sessionId, tokens);
  }

  return tokens.access_token;
}

async function canvaApiRequest(accessToken, method, path, body) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data?.message || `Canva API error ${resp.status}`);
    err.status = resp.status;
    err.details = data;
    throw err;
  }
  return data;
}

// --- Design + export helpers -----------------------------------------

async function createDesign(accessToken, { designType = 'doc', title } = {}) {
  const body = {
    design_type: { type: 'preset', name: designType },
    ...(title ? { title } : {}),
  };
  const data = await canvaApiRequest(accessToken, 'POST', '/designs', body);
  return data.design;
}

async function createExportJob(accessToken, { designId, format = 'png' }) {
  const data = await canvaApiRequest(accessToken, 'POST', '/exports', {
    design_id: designId,
    format: { type: format },
  });
  return data.job;
}

async function getExportJob(accessToken, jobId) {
  const data = await canvaApiRequest(accessToken, 'GET', `/exports/${jobId}`);
  return data.job;
}

// Polls an export job until it's done (success/failed) or attempts run out.
async function waitForExport(accessToken, jobId, { intervalMs = 2000, maxAttempts = 30 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const job = await getExportJob(accessToken, jobId);
    if (job.status === 'success' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Export job did not finish in time — poll GET /api/export/:jobId yourself');
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  stashPendingAuth,
  consumePendingAuth,
  createDesign,
  createExportJob,
  getExportJob,
  waitForExport,
};
