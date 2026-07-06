// lib/canva.js
//
// OAuth 2.0 + PKCE against the Canva Connect API

const crypto = require('crypto');
const { getTokens, saveTokens } = require('./tokenStore');

const AUTHORIZE_URL = 'https://www.canva.com/api/oauth/authorize';
const TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const API_BASE = 'https://api.canva.com/rest/v1';

// Your exact scopes from the URL
const SCOPES = [
  'asset:read',
  'brandtemplate:content:write',
  'folder:read',
  'design:content:read',
  'design:permission:read',
  'design:content:write',
  'folder:write',
  'comment:write',
  'brandtemplate:content:read',
  'asset:write',
  'brandtemplate:meta:read',
  'comment:read',
  'profile:read',
  'design:permission:write',
  'app:write',
  'app:read',
  'folder:permission:read',
  'folder:permission:write',
  'design:meta:read'
].join(' ');

function basicAuthHeader() {
  const credentials = `${process.env.CANVA_CLIENT_ID}:${process.env.CANVA_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

const pendingAuth = new Map();

function stashPendingAuth(state, verifier, sessionId) {
  pendingAuth.set(state, { verifier, sessionId, expiresAt: Date.now() + 10 * 60 * 1000 });
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
  url.searchParams.set('scope', SCOPES);
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

async function waitForExport(accessToken, jobId, { intervalMs = 2000, maxAttempts = 30 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const job = await getExportJob(accessToken, jobId);
    if (job.status === 'success' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Export job did not finish in time');
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
