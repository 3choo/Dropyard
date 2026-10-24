# gitctx

Your team's private GitHub replacement for FiveM server content — a Cloudflare
Worker + R2 + D1 app where a small team uploads resources, MLOs, vehicles and
full server builds as **immutable, versioned releases**, and the game server
pulls them over stable, token-authenticated URLs.

- Multi-GB uploads from the browser, **resumable across reloads**
  (presigned multipart, straight to R2 — the parts are kept on pause)
- Releases with notes, digests and rollback-by-republish
- Deploy tokens (global or per-project) for the FiveM server
- Email + password accounts, three roles: admin / uploader / viewer
- Optional Discord announcement on publish

## One-time setup (~5 minutes)

Requirements: a Cloudflare account, Node 20+, this repo.

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create gitctx
npx wrangler d1 create gitctx        # copy the database_id into wrangler.jsonc
npx wrangler d1 migrations apply gitctx --remote
```

Then in the Cloudflare dashboard: **R2 → Manage API tokens → Create API token**
(Object Read & Write, scoped to the `gitctx` bucket). Store the keys as Worker
secrets and put your account id in `wrangler.jsonc`:

```bash
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

```jsonc
// wrangler.jsonc -> vars
"R2_S3_ACCOUNT_ID": "your-cloudflare-account-id"
```

Allow the browser to talk to R2 directly — edit `r2-cors.json` to list your
real origins (your workers.dev URL after first deploy, plus any custom domain),
then apply it:

```bash
npx wrangler r2 bucket cors put gitctx --file r2-cors.json
```

Deploy:

```bash
npm run deploy        # builds the SPA and deploys the Worker
```

Open the printed URL → you land on **setup** to create the first admin
account. Invite teammates under **Admin → Invites**, create a deploy token
under **Admin → Deploy tokens**, done.

### Custom domain later

Dash → your Worker → **Settings → Domains & Routes → Add → Custom domain**
(e.g. `git.yourdomain.com`). Update `r2-cors.json` with the new origin and
re-run the cors put. Nothing else changes.

## Local development

```bash
npm run dev           # Worker on :8787 (D1 + R2 simulated locally)
npm run dev:web       # Vite on :5173, proxies /api and /dl to :8787
```

Local note: presigned uploads need real R2 S3 credentials, so in local dev
files are limited to the single-stream limit (~90 MB). Use
`wrangler dev --remote` or deploy to exercise the true multipart path.

## FiveM server side

Copy [`scripts/updater/`](scripts/updater/) to the server.

PowerShell (Windows / txAdmin):

```powershell
.\gitctx-updater.ps1 -BaseUrl https://gitctx.yourteam.workers.dev `
  -Token gctx_xxx -Slug server-artifacts -Dest C:\fxserver\artifacts
```

Linux (needs `curl` + `jq`):

```bash
BASE_URL=https://gitctx.yourteam.workers.dev \
TOKEN=gctx_xxx SLUG=server-artifacts DEST=/srv/fxserver/artifacts \
./gitctx-updater.sh
```

Both check a lightweight digest endpoint first — nothing downloads when the
release hasn't changed, so they're safe in a cron or txAdmin schedule.

## How it fits together

```
web/dist (Vite React SPA)
   │  static assets served by the Worker
   ▼
src/index.ts (Hono)
   ├── /api/auth/*      sessions, invites, first-run setup
   ├── /api/projects/*  projects, releases, publish, machine manifest
   ├── /api/uploads/*   upload sessions: presigned parts + single-stream
   ├── /api/admin/*     members, invites, tokens, audit, webhook
   ├── /dl/*            streaming downloads from R2 (Range + ETag support)
   └── D1 metadata, R2 objects at p/<project>/r/<release>/<path>
```

Uploads above ~90 MB never pass through the Worker: the browser PUTs 64 MB
parts directly to R2 using presigned URLs (each part carries a SHA-256 that
R2 verifies), which is why a 6 GB MLO survives a flaky connection — done
parts are listed from R2 on resume.

## Scripts

| Command           | What it does                                   |
| ----------------- | ---------------------------------------------- |
| `npm run dev`     | Worker locally on :8787                        |
| `npm run dev:web` | SPA dev server on :5173 (proxies the API)      |
| `npm run build`   | Build the SPA into `web/dist`                  |
| `npm run deploy`  | Build + `wrangler deploy`                      |
| `npm test`        | Worker integration tests (vitest, miniflare)   |
| `npm run typecheck` | TypeScript for Worker and SPA                |

## Cost reality

R2 storage is $0.015/GB-month with **zero egress fees** — a 30 GB library is
about $0.45/month. Workers Paid ($5/month) is recommended for a team; the
chunked/presigned design also stays within the free plan's request limits if
you want to start there.
