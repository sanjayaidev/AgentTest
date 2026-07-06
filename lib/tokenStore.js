// lib/tokenStore.js
//
// Minimal per-session token storage on local disk. Fine for a personal
// or small-team deployment on a single long-running Node process (this
// app is NOT designed for Vercel-style serverless — see README).
//
// Swap this out for Redis/Postgres/etc. if you deploy somewhere with
// multiple instances or ephemeral filesystems.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'tokens');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function tokenPath(sessionId) {
  // sessionId is a hex string we generate ourselves (see server.js) —
  // safe to use directly as a filename.
  return path.join(DATA_DIR, `${sessionId}.json`);
}

function saveTokens(sessionId, tokens) {
  ensureDir();
  fs.writeFileSync(tokenPath(sessionId), JSON.stringify(tokens, null, 2));
}

function getTokens(sessionId) {
  try {
    const raw = fs.readFileSync(tokenPath(sessionId), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function deleteTokens(sessionId) {
  try {
    fs.unlinkSync(tokenPath(sessionId));
  } catch {
    // already gone — fine
  }
}

module.exports = { saveTokens, getTokens, deleteTokens };
