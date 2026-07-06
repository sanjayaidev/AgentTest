// lib/pkce.js
//
// PKCE (Proof Key for Code Exchange) helpers, per Canva's spec:
// code_verifier: 43-128 chars, [A-Za-z0-9-._~] only.
// code_challenge: base64url(sha256(code_verifier)).

const crypto = require('crypto');

function base64url(buf) {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function createVerifier() {
  // 96 random bytes -> 128 base64url chars, well within the 43-128 range.
  return base64url(crypto.randomBytes(96));
}

function createChallenge(verifier) {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

function createPkcePair() {
  const verifier = createVerifier();
  const challenge = createChallenge(verifier);
  return { verifier, challenge };
}

function createState() {
  return base64url(crypto.randomBytes(32));
}

module.exports = { createPkcePair, createState };
