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

// Sanitize a design title so it's safe to use inside a filename on Windows
function sanitizeFilename(name) {
  return (
    String(name || 'design')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'design'
  );
}

// Build the contents of a Windows .bat file that downloads every given
// export result (one curl call per file) into a "canva-downloads" folder.
function buildDownloadAllBat(results, format) {
  const successResults = results.filter((r) => r.status === 'success' && r.urls && r.urls.length);
  const failedResults = results.filter((r) => !(r.status === 'success' && r.urls && r.urls.length));
  const totalFiles = successResults.reduce((sum, r) => sum + r.urls.length, 0);

  let script = '@echo off\r\n';
  script += 'setlocal enabledelayedexpansion\r\n';
  script += 'REM Canva - Download All Designs\r\n';
  script += 'REM Auto-generated by AgentTest (canva-export-all)\r\n';
  script += 'REM Requires curl, which ships with Windows 10/11 by default\r\n';
  script += '\r\n';
  script += 'if not exist "canva-downloads" mkdir "canva-downloads"\r\n';
  script += 'cd canva-downloads\r\n';
  script += '\r\n';
  script += `echo Downloading ${totalFiles} file(s) from ${successResults.length} design(s)...\r\n`;
  script += 'echo.\r\n';
  script += '\r\n';

  let idx = 1;
  for (const r of successResults) {
    const safeTitle = sanitizeFilename(r.title);
    r.urls.forEach((url, j) => {
      const suffix = r.urls.length > 1 ? `_page${j + 1}` : '';
      const filename = `${safeTitle}_${r.designId}${suffix}.${format}`;
      script += `echo [${idx}/${totalFiles}] ${filename}\r\n`;
      script += `curl -L "${url}" -o "${filename}"\r\n`;
      script += `if errorlevel 1 echo   ^> WARNING: failed to download ${filename}\r\n`;
      script += '\r\n';
      idx++;
    });
  }

  if (failedResults.length) {
    script += 'echo.\r\n';
    script += `echo ${failedResults.length} design(s) could not be exported and were skipped:\r\n`;
    for (const f of failedResults) {
      script += `echo   - ${sanitizeFilename(f.title)} (${f.designId})\r\n`;
    }
    script += '\r\n';
  }

  script += 'echo.\r\n';
  script += 'echo All downloads complete! Files are in the "canva-downloads" folder.\r\n';
  script += 'pause\r\n';

  return script;
}

// One-click endpoint: list every design in the account, export each one,
// and stream back a .bat file that downloads them all on the user's PC.
app.get('/api/exports/all-as-bat', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    if (!token) {
      return res.status(403).json({ error: 'Not connected', connect_url: '/auth/canva' });
    }

    const format = (req.query.format || 'png').toString();

    const designs = await listDesigns(token);
    if (!designs.length) {
      return res.status(404).json({ error: 'No designs found in this Canva account' });
    }

    const results = [];
    for (const design of designs) {
      try {
        const job = await createExportJob(token, { designId: design.id, format });
        const finished = await waitForExport(token, job.id);
        results.push({
          designId: design.id,
          title: design.title,
          status: finished.status,
          urls: finished.urls || [],
          error: finished.error,
        });
      } catch (err) {
        results.push({
          designId: design.id,
          title: design.title,
          status: 'failed',
          urls: [],
          error: { message: err.message },
        });
      }
      // Small delay between exports to stay under Canva's rate limit
      // (75 exports per user per 5 minutes).
      await new Promise((r) => setTimeout(r, 300));
    }

    const batScript = buildDownloadAllBat(results, format);
    const filename = `canva-download-all-${Date.now()}.bat`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(batScript);
  } catch (err) {
    console.error('[ERROR] all-as-bat failed:', err.message);
    res.status(err.status || 500).json({ error: err.message, details: err.details });
  }
});

// Build a .bat from thumbnail URLs the list-designs API already returns —
// no /exports calls at all, so this is NOT subject to Canva's export rate
// limit (75 exports/5min). Trade-off: you get the thumbnail/preview image
// for each design, not a full-resolution export.
function buildThumbnailsBat(designs) {
  const withThumb = designs.filter((d) => d.thumbnail && d.thumbnail.url);
  const withoutThumb = designs.filter((d) => !(d.thumbnail && d.thumbnail.url));

  let script = '@echo off\r\n';
  script += 'setlocal enabledelayedexpansion\r\n';
  script += 'REM Canva - Download All Design Thumbnails\r\n';
  script += 'REM Auto-generated by AgentTest (canva-export-all)\r\n';
  script += 'REM Uses the thumbnail URL from the design list API directly, so it\r\n';
  script += 'REM is NOT subject to Canva\'s export rate limit (75 exports/5min).\r\n';
  script += 'REM Note: these are preview-quality thumbnails, not full exports.\r\n';
  script += 'REM Requires curl, which ships with Windows 10/11 by default\r\n';
  script += '\r\n';
  script += 'if not exist "canva-thumbnails" mkdir "canva-thumbnails"\r\n';
  script += 'cd canva-thumbnails\r\n';
  script += '\r\n';
  script += `echo Downloading ${withThumb.length} thumbnail(s)...\r\n`;
  script += 'echo.\r\n';
  script += '\r\n';

  withThumb.forEach((d, i) => {
    const safeTitle = sanitizeFilename(d.title);
    const filename = `${safeTitle}_${d.id}.jpg`;
    script += `echo [${i + 1}/${withThumb.length}] ${filename}\r\n`;
    script += `curl -L "${d.thumbnail.url}" -o "${filename}"\r\n`;
    script += `if errorlevel 1 echo   ^> WARNING: failed to download ${filename}\r\n`;
    script += '\r\n';
  });

  if (withoutThumb.length) {
    script += 'echo.\r\n';
    script += `echo ${withoutThumb.length} design(s) had no thumbnail and were skipped:\r\n`;
    for (const d of withoutThumb) {
      script += `echo   - ${sanitizeFilename(d.title)} (${d.id})\r\n`;
    }
    script += '\r\n';
  }

  script += 'echo.\r\n';
  script += 'echo Done! Files are in the "canva-thumbnails" folder.\r\n';
  script += 'pause\r\n';

  return script;
}

// One-click, rate-limit-free endpoint: list every design and build a .bat
// straight from the thumbnail URLs — no per-design export call.
app.get('/api/designs/thumbnails-bat', async (req, res) => {
  try {
    const token = await getValidAccessToken(req.sessionId);
    if (!token) {
      return res.status(403).json({ error: 'Not connected', connect_url: '/auth/canva' });
    }

    const designs = await listDesigns(token);
    if (!designs.length) {
      return res.status(404).json({ error: 'No designs found in this Canva account' });
    }

    const batScript = buildThumbnailsBat(designs);
    const filename = `canva-thumbnails-${Date.now()}.bat`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(batScript);
  } catch (err) {
    console.error('[ERROR] thumbnails-bat failed:', err.message);
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

// Batch export multiple designs - returns CDN URLs directly (parallel processing)
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

// Sequential batch export - processes one file at a time for better reliability
app.post('/api/exports/batch-sequential', async (req, res) => {
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
    
    // Process exports sequentially - one at a time
    for (const designId of designIds) {
      try {
        console.log('[DEBUG] Exporting design:', designId);
        const job = await createExportJob(token, { designId, format });
        const finished = await waitForExport(token, job.id);
        
        if (finished.status === 'success') {
          results.push({
            designId,
            status: 'success',
            urls: finished.urls || []
          });
        } else {
          results.push({
            designId,
            status: 'failed',
            error: finished.error || { message: 'Export failed' }
          });
        }
      } catch (err) {
        console.error('[ERROR] Export failed for design:', designId, err.message);
        results.push({
          designId,
          status: 'failed',
          error: { message: err.message }
        });
      }
      
      // Small delay between exports to avoid rate limits
      if (designIds.indexOf(designId) < designIds.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    res.json({ results });
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
