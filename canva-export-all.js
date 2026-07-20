#!/usr/bin/env node
/**
 * canva-export-all.js
 *
 * Lists every design in your Canva account, exports each one as PNG,
 * downloads the files, and pushes them to a GitHub repo.
 *
 * Requirements:
 *   - Node.js 18+ (uses the built-in `fetch`)
 *   - git installed and authenticated (SSH key or credential helper) for the
 *     target GitHub repo
 *   - A Canva integration (Client ID + Secret) created at
 *     https://www.canva.com/developers/integrations with these scopes enabled:
 *       design:content:read, design:meta:read, asset:read
 *     and redirect URI: http://127.0.0.1:8787/callback
 *
 * Config (env vars, or edit the CONFIG block below):
 *   CANVA_CLIENT_ID
 *   CANVA_CLIENT_SECRET
 *   GITHUB_REPO_URL     e.g. git@github.com:yourname/canva-designs.git
 *   OUTPUT_DIR          default: ./canva-designs
 *
 * Usage:
 *   CANVA_CLIENT_ID=xxx CANVA_CLIENT_SECRET=yyy \
 *   GITHUB_REPO_URL=git@github.com:yourname/canva-designs.git \
 *   node canva-export-all.js
 */

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const CONFIG = {
  clientId: process.env.CANVA_CLIENT_ID || "",
  clientSecret: process.env.CANVA_CLIENT_SECRET || "",
  redirectUri: "http://127.0.0.1:8787/callback",
  scopes: "design:content:read design:meta:read asset:read",
  githubRepoUrl: process.env.GITHUB_REPO_URL || "",
  outputDir: process.env.OUTPUT_DIR || path.join(process.cwd(), "canva-designs"),
};

function assertConfig() {
  const missing = [];
  if (!CONFIG.clientId) missing.push("CANVA_CLIENT_ID");
  if (!CONFIG.clientSecret) missing.push("CANVA_CLIENT_SECRET");
  if (!CONFIG.githubRepoUrl) missing.push("GITHUB_REPO_URL");
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    console.error("See the header of this script for setup instructions.");
    process.exit(1);
  }
}

function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pkcePair() {
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitize(name) {
  return name.replace(/[^a-z0-9_\-]+/gi, "_").slice(0, 80) || "untitled";
}

// ---- Step 1: OAuth authorization (opens a local server for the callback) ----
function authorize() {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = pkcePair();
    const state = base64url(crypto.randomBytes(16));

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1:8787");
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Authorization failed or state mismatch. You can close this tab.");
        server.close();
        reject(new Error("OAuth callback missing code or state mismatch"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Canva authorized. You can close this tab and go back to the terminal.");
      server.close();
      resolve({ code, verifier });
    });

    server.listen(8787, () => {
      const authUrl =
        `https://www.canva.com/api/oauth/authorize?` +
        `code_challenge=${challenge}&code_challenge_method=s256&` +
        `scope=${encodeURIComponent(CONFIG.scopes)}&response_type=code&` +
        `client_id=${CONFIG.clientId}&state=${state}&` +
        `redirect_uri=${encodeURIComponent(CONFIG.redirectUri)}`;

      console.log("\nOpen this URL in your browser to authorize access to your Canva account:\n");
      console.log(authUrl + "\n");
      try {
        const opener =
          process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        execSync(`${opener} "${authUrl}"`, { stdio: "ignore" });
      } catch {
        // ignore — user can click the printed link manually
      }
    });
  });
}

async function exchangeCodeForTokens(code, verifier) {
  const basic = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: CONFIG.redirectUri,
  });
  const res = await fetch("https://api.canva.com/rest/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

// ---- Step 2: List all designs (paginated) ----
async function listAllDesigns(accessToken) {
  const designs = [];
  let continuation = null;
  do {
    const url = new URL("https://api.canva.com/rest/v1/designs");
    if (continuation) url.searchParams.set("continuation", continuation);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`List designs failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    designs.push(...(data.items || []));
    continuation = data.continuation || null;
  } while (continuation);
  return designs;
}

// ---- Step 3: Export a design as PNG and poll until done ----
async function exportDesignAsPng(accessToken, designId) {
  const createRes = await fetch("https://api.canva.com/rest/v1/exports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ design_id: designId, format: { type: "png" } }),
  });
  if (!createRes.ok) throw new Error(`Create export failed: ${createRes.status} ${await createRes.text()}`);
  const { job } = await createRes.json();

  let status = job.status;
  let jobId = job.id;
  let result = job.result;

  while (status === "in_progress") {
    await sleep(2000);
    const pollRes = await fetch(`https://api.canva.com/rest/v1/exports/${jobId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!pollRes.ok) throw new Error(`Poll export failed: ${pollRes.status} ${await pollRes.text()}`);
    const polled = (await pollRes.json()).job;
    status = polled.status;
    result = polled.result;
  }

  if (status !== "success") throw new Error(`Export job ${jobId} ended with status: ${status}`);
  return result.urls || []; // one URL per page for multi-page designs
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
}

// ---- Step 4: push to GitHub ----
function pushToGitHub(dir) {
  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: "inherit" });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    run("git init");
    run("git checkout -b main");
  }
  try {
    execSync("git remote get-url origin", { cwd: dir, stdio: "ignore" });
  } catch {
    run(`git remote add origin ${CONFIG.githubRepoUrl}`);
  }
  run("git add .");
  try {
    run(`git commit -m "Sync Canva designs (${new Date().toISOString()})"`);
  } catch {
    console.log("Nothing new to commit.");
  }
  run("git push -u origin main");
}

// ---- Main ----
async function main() {
  assertConfig();
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  console.log("Starting Canva authorization...");
  const { code, verifier } = await authorize();
  const tokens = await exchangeCodeForTokens(code, verifier);
  console.log("Authorized. Fetching your designs...");

  const designs = await listAllDesigns(tokens.access_token);
  console.log(`Found ${designs.length} design(s).`);

  for (const [i, design] of designs.entries()) {
    const title = sanitize(design.title || design.id);
    const folder = path.join(CONFIG.outputDir, `${title}-${design.id}`);
    fs.mkdirSync(folder, { recursive: true });
    console.log(`[${i + 1}/${designs.length}] Exporting "${design.title || design.id}"...`);
    try {
      const urls = await exportDesignAsPng(tokens.access_token, design.id);
      for (const [pageIdx, url] of urls.entries()) {
        const fileName = urls.length > 1 ? `page-${pageIdx + 1}.png` : `design.png`;
        await downloadFile(url, path.join(folder, fileName));
      }
      console.log(`  Saved ${urls.length} file(s) to ${folder}`);
    } catch (err) {
      console.error(`  Skipped "${design.title || design.id}": ${err.message}`);
    }
  }

  console.log("\nAll designs processed. Pushing to GitHub...");
  pushToGitHub(CONFIG.outputDir);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
