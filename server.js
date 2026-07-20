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
  listDesigns,
} = require('./lib/canva');
const { saveTokens, deleteTokens } = require('./lib/tokenStore');

const REQUIRED_ENV = ['CANVA_CLIENT_ID', 'CANVA_CLIENT_SECRET', 'CANVA_REDIRECT_URI'];

const app = express();
app.use(express.json());

// Serve the export page at /export (before static middleware to take precedence)
app.get('/export', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'export.html'));
});

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

    // Auto-redirect with a success message
    res.send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Connected to Canva</title>
          <meta http-equiv="refresh" content="2;url=/">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              text-align: center;
              margin-top: 80px;
              background: #0f1115;
              color: #e8eaed;
            }
            .checkmark {
              font-size: 64px;
              color: #3ecf6f;
              margin-bottom: 20px;
            }
            .spinner {
              display: inline-block;
              margin-top: 20px;
              width: 24px;
              height: 24px;
              border: 3px solid #2a2e38;
              border-radius: 50%;
              border-top-color: #7c5cff;
              animation: spin 0.8s linear infinite;
            }
            @keyframes spin {
              to { transform: rotate(360deg); }
            }
          </style>
        </head>
        <body>
          <div class="checkmark">✅</div>
          <h2>Canva connected successfully!</h2>
          <p>Redirecting you back to the app...</p>
          <div class="spinner"></div>
          <p style="font-size: 14px; margin-top: 20px; color: #666;">
            <a href="/" style="color: #7c5cff;">Click here if you're not redirected</a>
          </p>
          <script>
            // Notify parent window if in popup
            if (window.opener) {
              window.opener.postMessage('canva-connected', '*');
            }
          </script>
        </body>
      </html>
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
// Add this route to server.js - Get user capabilities
app.get('/api/capabilities', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    if (!token) {
      return res.status(403).json({ 
        error: 'Not connected to Canva', 
        connect_url: '/auth/canva' 
      });
    }

    const response = await fetch('https://api.canva.com/rest/v1/users/me/capabilities', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.message || 'Failed to fetch capabilities');
    }

    res.json({
      connected: true,
      capabilities: data.capabilities || [],
      hasAutofill: data.capabilities?.includes('autofill') || false,
      hasBrandTemplate: data.capabilities?.includes('brand_template') || false,
      hasResize: data.capabilities?.includes('resize') || false
    });
  } catch (err) {
    res.status(500).json({ 
      error: err.message,
      details: err.details || null
    });
  }
});

// List all designs for the user
app.get('/api/designs/list', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    if (!token) {
      return res.status(403).json({ error: 'Not connected', connect_url: '/auth/canva' });
    }

    console.log('[DEBUG] Fetching designs for session:', req.sessionId);
    const designs = await listDesigns(token);
    console.log('[DEBUG] Designs fetched:', designs?.length || 0);
    
    if (!designs || !Array.isArray(designs)) {
      console.log('[DEBUG] Unexpected designs format:', designs);
      return res.json({ designs: [], warning: 'Unexpected API response format', rawResponse: designs });
    }
    
    res.json({ designs });
  } catch (err) {
    console.error('[ERROR] Failed to list designs:', err.message, err.details);
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

// Batch export multiple designs - returns CDN URLs directly
app.post('/api/exports/batch', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    if (!token) {
      return res.status(403).json({ error: 'Not connected', connect_url: '/auth/canva' });
    }

    const { designIds, format } = req.body || {};
    if (!designIds || !Array.isArray(designIds) || designIds.length === 0) {
      return res.status(400).json({ error: '"designIds" is required and must be a non-empty array' });
    }

    const results = [];
    
    // Process exports in parallel (with a reasonable limit)
    const exportPromises = designIds.map(async (designId) => {
      try {
        const job = await createExportJob(token, { designId, format });
        const finished = await waitForExport(token, job.id);
        
        if (finished.status === 'success') {
          // Return CDN URLs directly for download
          return {
            designId,
            status: 'success',
            urls: finished.urls || [],
            // Mark for CDN download
            useCdn: true
          };
        } else {
          return {
            designId,
            status: 'failed',
            error: finished.error || { message: 'Export failed' }
          };
        }
      } catch (err) {
        return {
          designId,
          status: 'failed',
          error: { message: err.message }
        };
      }
    });

    const batchResults = await Promise.all(exportPromises);
    res.json({ results: batchResults });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

// Endpoint to prepare Git LFS repository structure
app.post('/api/exports/git-lfs', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    if (!token) {
      return res.status(403).json({ error: 'Not connected', connect_url: '/auth/canva' });
    }

    const { designIds, format, repoName = 'canva-exports' } = req.body || {};
    if (!designIds || !Array.isArray(designIds) || designIds.length === 0) {
      return res.status(400).json({ error: '"designIds" is required and must be a non-empty array' });
    }

    console.log('[DEBUG] Preparing Git LFS export for', designIds.length, 'designs');
    
    const batchResults = [];
    const batchSize = 10; // Process in batches of 10
    
    // Process in smaller batches to avoid rate limits
    for (let i = 0; i < designIds.length; i += batchSize) {
      const batch = designIds.slice(i, i + batchSize);
      console.log('[DEBUG] Processing batch', Math.floor(i / batchSize) + 1, 'with', batch.length, 'designs');
      
      const batchPromises = batch.map(async (designId) => {
        try {
          const job = await createExportJob(token, { designId, format });
          const finished = await waitForExport(token, job.id);
          
          if (finished.status === 'success') {
            return {
              designId,
              status: 'success',
              urls: finished.urls || []
            };
          } else {
            return {
              designId,
              status: 'failed',
              error: finished.error || { message: 'Export failed' }
            };
          }
        } catch (err) {
          return {
            designId,
            status: 'failed',
            error: { message: err.message }
          };
        }
      });
      
      const batchCompleted = await Promise.all(batchPromises);
      batchResults.push(...batchCompleted);
      
      // Small delay between batches
      if (i + batchSize < designIds.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    
    // Generate Git LFS tracking file content
    const lfsTracking = batchResults
      .filter(r => r.status === 'success' && r.urls.length > 0)
      .map((result, index) => {
        const filename = `${result.designId}.${format}`;
        const url = result.urls[0];
        return `version https://git-lfs.github.com/spec/v1
oid sha256:${result.designId}
size 0
url ${url}`;
      })
      .join('\n\n');
    
    res.json({ 
      results: batchResults,
      repoName,
      format,
      totalProcessed: batchResults.length,
      successCount: batchResults.filter(r => r.status === 'success').length,
      lfsTracking
    });
  } catch (err) {
    console.error('[ERROR] Git LFS export failed:', err);
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});
