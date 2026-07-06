# canva-connect-app

Standalone app that creates and exports Canva designs on behalf of a
user, using the **Canva Connect API** (`api.canva.com` / OAuth 2.0 +
PKCE) — a different, self-service integration surface from Canva's MCP
server (`mcp.canva.com`).

**Why this exists:** Canva's MCP server requires your redirect URI to be
manually approved via Canva's waitlist before you can even register an
OAuth client (`Invalid redirect URI. It must be from an allowed host.`
if you try before approval). The Connect API used here has no such
gate — you self-serve an integration in the Developer Portal and start
authorizing users immediately.

This app is deliberately separate from any MCP-based project — it's a
plain long-running Node/Express server, not a serverless function, so
token storage can just be local JSON files. Don't deploy this to
Vercel-style serverless as-is (see "Deploying" below if you want to).

## 1. Create a Canva integration

1. Go to <https://www.canva.com/developers/integrations> and create a new integration.
2. On the **Configuration** tab, copy the **Client ID**, then click **Generate secret** and copy the **Client Secret**. The secret is only shown once.
3. On the **Authentication** tab, add a redirect URI. For local dev:
   ```
   http://localhost:3000/auth/canva/callback
   ```
   This must match `CANVA_REDIRECT_URI` in your `.env` byte-for-byte (scheme, host, port, path, trailing slash).
4. On the **Scopes** tab, enable at least:
   - `design:content:read`
   - `design:content:write`
   - `asset:read`
   - `asset:write`

   You can only request scopes here — anything you ask for later in the OAuth URL that isn't enabled here will fail.

## 2. Configure

```bash
cp .env.example .env
```

Fill in `CANVA_CLIENT_ID`, `CANVA_CLIENT_SECRET`, `CANVA_REDIRECT_URI` (matching step 1.3 exactly), and generate a `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Run

```bash
npm install
npm start
```

Open <http://localhost:3000>, click **Connect Canva**, approve access, then:
- **Create design** — makes a blank design of the chosen type, gives you an "Open in Canva to edit" link
- **Export design** — exports a design (by ID) to PNG/JPG/PDF/PPTX and gives you a download link

Note: blank designs created via the API are auto-deleted if untouched for 7 days — this bypasses the user's trash, so it's permanent.

## Deploying somewhere real

This app uses:
- A signed-cookie-free, random-hex session ID per browser (good enough for personal/small-team use, not a full auth system)
- Local JSON files under `data/tokens/` for token storage — **this requires a persistent, single-instance filesystem**. It will NOT work correctly on Vercel/serverless (ephemeral filesystem, multiple instances) or behind a load balancer with more than one instance.

To deploy on serverless or with multiple instances, swap `lib/tokenStore.js` for Redis/Postgres/etc — same pattern as `getTokens`/`saveTokens`/`deleteTokens`, just backed by a shared store instead of local disk. Also move `pendingAuth` (in `lib/canva.js`) to that same shared store, since right now it's an in-memory `Map` that only works within a single process.

## Endpoints

| Method | Path | What |
|---|---|---|
| GET | `/auth/canva` | Start OAuth flow (redirects to Canva) |
| GET | `/auth/canva/callback` | OAuth redirect target, exchanges code for tokens |
| GET | `/api/status` | `{ connected: boolean }` for the current session |
| POST | `/api/disconnect` | Deletes stored tokens for the current session |
| POST | `/api/designs` | Body: `{ designType?, title? }` → creates a design |
| POST | `/api/exports` | Body: `{ designId, format? }` → exports and polls until done |

## Scopes reference

Full list: <https://www.canva.dev/docs/connect/appendix/scopes/>
