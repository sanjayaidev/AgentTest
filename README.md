# canva-export-all

Downloads every design in your Canva account as PNG and pushes them to a
GitHub repo — all from the terminal.

No npm packages needed (Node 18+ only).

## 1. Create a Canva integration

1. Go to https://www.canva.com/developers/integrations → create a new integration.
2. **Configuration** tab → copy the **Client ID**, click **Generate secret** → copy the **Client Secret** (only shown once).
3. **Authentication** tab → add this redirect URI exactly:
   ```
   http://127.0.0.1:8787/callback
   ```
4. **Scopes** tab → enable:
   - `design:content:read`
   - `design:meta:read`
   - `asset:read`

## 2. Create the destination GitHub repo

Create an empty repo, e.g. `canva-designs`, on GitHub. Make sure `git` on
your machine can push to it (SSH key added, or `gh auth login` / a
credential helper set up).

## 3. Run it

```bash
CANVA_CLIENT_ID=your_client_id \
CANVA_CLIENT_SECRET=your_client_secret \
GITHUB_REPO_URL=git@github.com:yourname/canva-designs.git \
node canva-export-all.js
```

What happens:

1. A browser tab opens (or a URL is printed) asking you to approve access
   to your Canva account — this is a one-time authorization per run.
2. The script lists every design in your account (handles pagination).
3. Each design is exported as PNG and downloaded into
   `./canva-designs/<title>-<designId>/`.
4. The `canva-designs` folder is git-initialized (if needed), committed,
   and pushed to `GITHUB_REPO_URL`.

## Notes

- Access tokens expire after ~4 hours; for a one-off bulk export this
  script's single run is well within that window. If you want to re-run it
  later, just run it again — it re-authorizes each time.
- Multi-page designs export as `page-1.png`, `page-2.png`, etc.
- Canva export download links expire after 24 hours — the script
  downloads them immediately, so this isn't an issue.
- If a specific design fails to export (e.g. unsupported type), the
  script logs it and continues with the rest.
- Rate limits: exports are capped at 75 per user per 5 minutes — if you
  have hundreds of designs, the script may hit that and you may need to
  re-run it to pick up any that failed.
