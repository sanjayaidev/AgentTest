// lib/tokenStore.js
// 
// Token storage for Railway - uses /data directory which persists
// between restarts on Railway

const fs = require('fs');
const path = require('path');

// Use /data directory on Railway, fallback to local data directory
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH 
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'tokens')
  : path.join(__dirname, '..', 'data', 'tokens');

function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn('Could not create token directory:', err.message);
    // Fallback to memory if we can't write to disk
  }
}

function tokenPath(sessionId) {
  return path.join(DATA_DIR, `${sessionId}.json`);
}

function saveTokens(sessionId, tokens) {
  try {
    ensureDir();
    fs.writeFileSync(tokenPath(sessionId), JSON.stringify(tokens, null, 2));
  } catch (err) {
    console.error('Failed to save tokens:', err.message);
    // In-memory fallback
    if (!global._tokenMemory) global._tokenMemory = new Map();
    global._tokenMemory.set(sessionId, tokens);
  }
}

function getTokens(sessionId) {
  try {
    const raw = fs.readFileSync(tokenPath(sessionId), 'utf8');
    return JSON.parse(raw);
  } catch {
    // Check memory fallback
    if (global._tokenMemory) {
      return global._tokenMemory.get(sessionId) || null;
    }
    return null;
  }
}

function deleteTokens(sessionId) {
  try {
    fs.unlinkSync(tokenPath(sessionId));
  } catch {
    // already gone — fine
  }
  if (global._tokenMemory) {
    global._tokenMemory.delete(sessionId);
  }
}

module.exports = { saveTokens, getTokens, deleteTokens };
