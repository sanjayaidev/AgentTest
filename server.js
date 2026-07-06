// server.js
//
// Standalone app for Railway deployment

require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');

const { createPkcePair, createState } = require('./lib/pkce');
const {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  getValidAccessToken,
  stashPendingAuth,
  consumePendingAuth,
  createDesign,
  createExportJob,
  waitForExport,
} = require('./lib/canva');
const { saveTokens, deleteTokens } = require('./lib/tokenStore');

const REQUIRED_ENV = ['CANVA_CLIENT_ID', 'CANVA_CLIENT_SECRET', 'CANVA_REDIRECT_URI'];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SESSION_COOKIE = 'ccapp_session';

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((p) => {
      const idx = p.indexOf('=');
      return [p.slice(0, idx).trim(), decodeURIComponent(p.slice(idx + 1).trim())];
    })
  );
}

app.use((req, res, next) => {
  const cookies = parseCookies(req);
  let sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) {
    sessionId = crypto.randomBytes(24).toString('hex');
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`
    );
  }
  req.sessionId = sessionId;
  next();
});

function checkEnv(res) {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    res.status(500).json({ error: `Missing required env var(s): ${missing.join(', ')}` });
    return false;
  }
  return true;
}

app.get('/auth/canva', (req, res) => {
  if (!checkEnv(res)) return;

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  stashPendingAuth(state, verifier, req.sessionId);

  const url = buildAuthorizeUrl({ state, codeChallenge: challenge });
  res.redirect(url);
});

app.get('/auth/canva/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res
        .status(400)
        .send(`<p>Canva authorization error: ${error} — ${error_description || ''}</p><p><a href="/">Back</a></p>`);
    }
    if (!code || !state) {
      return res.status(400).send('<p>Missing code or state.</p><p><a href="/">Back</a></p>');
    }

    const pending = consumePendingAuth(state);
    if (!pending) {
      return res
        .status(400)
        .send('<p>Invalid or expired state — start again from the home page.</p><p><a href="/">Back</a></p>');
    }

    const tokens = await exchangeCodeForTokens(code, pending.verifier);
    saveTokens(pending.sessionId, tokens);

    res.send(`
      <!doctype html><html><body style="font-family:sans-serif;text-align:center;margin-top:80px;">
        <h2>✅ Canva connected</h2>
        <p>You can close this tab and go back to the app.</p>
        <script>if (window.opener) { window.opener.postMessage('canva-connected', '*'); }</script>
      </body></html>
    `);
  } catch (err) {
    console.error('OAuth callback failed:', err.message);
    res.status(500).send(`<p>Callback failed: ${err.message}</p><p><a href="/">Back</a></p>`);
  }
});

app.get('/api/status', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    res.json({ connected: Boolean(token) });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

app.post('/api/disconnect', (req, res) => {
  deleteTokens(req.sessionId);
  res.json({ ok: true });
});

app.post('/api/designs', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    if (!token) return res.status(403).json({ error: 'Not connected', connect_url: '/auth/canva' });

    const { designType, title } = req.body || {};
    const design = await createDesign(token, { designType, title });
    res.json({ design });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

app.post('/api/exports', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    if (!token) return res.status(403).json({ error: 'Not connected', connect_url: '/auth/canva' });

    const { designId, format } = req.body || {};
    if (!designId) return res.status(400).json({ error: '"designId" is required' });

    const job = await createExportJob(token, { designId, format });
    const finished = await waitForExport(token, job.id);
    res.json({ job: finished });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`canva-connect-app listening on http://localhost:${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    console.warn(`⚠ Missing env vars: ${missing.join(', ')}`);
  }
});
