# dropyard

Your team's private GitHub replacement for FiveM server content — a Cloudflare
Worker + R2 + D1 app where a small team uploads resources, MLOs, vehicles and
full server builds as **immutable, versioned releases**, and the game server
pulls them over stable, token-authenticated URLs.

- Multi-GB uploads from the browser, **resumable across reloads**
  (presigned multipart, straight to R2 — the parts are kept on pause)
- **Automatic archive unpacking**: upload a `.zip` or `.rar` of the whole
  build and its contents appear in the release — the archive itself is dropped
  once everything extracts
- Releases with notes, digests and rollback-by-republish
- Deploy tokens (global or per-project) for the FiveM server
- Email + password accounts, three roles: admin / uploader / viewer
- Optional Discord announcement on publish
- **Real Git hosting**: every project is a Git repository that GitHub Desktop
  (or plain `git`) clones, pulls and pushes, with a GitHub-style Code tab,
  commit history, diffs, branches, pull requests with reviews, issues and
  comments. Releases are tagged snapshots of commits.

## Quick start

Requirements: a Cloudflare account (Workers, D1 and, for the default setup, R2), Node 20+, and Docker only if you want `.rar` unpacking.

```bash
git clone https://github.com/3choo/dropyard.git && cd dropyard
npm install
npx wrangler login
npm run setup      # creates the bucket + D1 database, writes wrangler.local.jsonc, stores secrets, applies CORS + migrations
npm run deploy     # builds the SPA and deploys the Worker (+ RAR container; Docker must be running)
```

Open the printed URL → you land on **setup** to create the first admin
account. Invite teammates under **Admin → Invites**, create a deploy token
under **Admin → Deploy tokens**, done.

`npm run setup` writes your personal IDs and settings to `wrangler.local.jsonc`
(gitignored). `npm run deploy` and `npm run migrate:remote` use that file when
it exists and fall back to the committed `wrangler.jsonc` template.

## Storage backends

dropyard stores release files and Git blobs in object storage. Two modes:

| Mode | When | Config |
| ---- | ---- | ------ |
| **Cloudflare R2** (default) | You deploy on Cloudflare and want zero egress fees | R2 bucket bound as `BUCKET`, plus R2 S3 keys for large uploads |
| **Any S3-compatible service** | AWS S3, MinIO, Backblaze B2, Wasabi, DigitalOcean Spaces, ... | `STORAGE_BACKEND=s3` and the `S3_*` settings below |

`npm run setup` asks which one you want and configures it. To do it by hand,
set these in `wrangler.local.jsonc` → `vars` (and remove the `r2_buckets`
entry for pure S3):

| Setting | Kind | Meaning |
| ------- | ---- | ------- |
| `STORAGE_BACKEND` | var | `s3` to use the S3 API even if an R2 binding exists. Unset = R2 binding |
| `S3_ENDPOINT` | var | e.g. `https://s3.eu-central-1.amazonaws.com`, `https://minio.example.com` |
| `S3_REGION` | var | Signing region (default `auto`; AWS needs the real one) |
| `S3_BUCKET` | var | Bucket name |
| `S3_FORCE_PATH_STYLE` | var | `true` (default) for `endpoint/bucket/key`, `false` for `bucket.endpoint/key` |
| `S3_ACCESS_KEY_ID` | secret | `npx wrangler secret put S3_ACCESS_KEY_ID -c wrangler.local.jsonc` |
| `S3_SECRET_ACCESS_KEY` | secret | same |

For R2 the older `R2_S3_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID` and
`R2_SECRET_ACCESS_KEY` names still work and are used when no `S3_*` value is set.

Whatever the backend, the browser uploads big files straight to the bucket
with presigned URLs, so the bucket needs a **CORS rule** for your dropyard
origin (methods `GET`, `PUT`, `HEAD`; expose the `ETag` header). The setup
script applies it for R2 and prints the JSON for other providers. For R2 the
template is [`r2-cors.json`](r2-cors.json):

```bash
npx wrangler r2 bucket cors put dropyard --file r2-cors.json
```

Non-R2 backends buffer single-request uploads (up to `MAX_SINGLE_UPLOAD_MB`)
inside the Worker, and the Worker needs outbound access to the endpoint.

### Archive unpacking (one extra step)

`.zip` uploads are extracted inside the Worker with no extra setup. `.rar`
support runs a real 7-Zip in a Cloudflare Container, which needs:

1. **Docker running** on the machine that deploys (`wrangler deploy` builds the
   image from `container/`).
2. The S3 credentials from the setup above (the container reads and writes
   storage directly; it works with any S3 backend).
3. A shared secret the container uses to call back home. `npm run setup` generates it; by hand:

```bash
npx wrangler secret put EXTRACT_CALLBACK_SECRET   # any long random string
```

Then apply the v2 migration once:

```bash
npx wrangler d1 migrations apply dropyard --remote
```

How it behaves:

- Extraction starts the moment an archive finishes uploading into a **draft**
  release. ZIPs of any size stream through the Worker; RARs (including
  multi-volume `.part1.rar` / `.part2.rar` sets) unpack in the container.
- When the unpack succeeds the archive is deleted — the release holds only the
  extracted files, so the updater never downloads it twice. If it fails, the
  archive stays and the release page shows a **Retry** button.
- Publishing is blocked while an archive is still unpacking.
- Continuation volumes (`.part2.rar`, `.r00`, …) never trigger extraction on
  their own: upload all parts, then hit Retry on the failed first-volume job.
- Limits (tunable in `wrangler.jsonc`): `MAX_UNPACK_FILES` (20000),
  `MAX_UNPACK_FILE_MB` (5120), `MAX_UNPACK_TOTAL_MB` (51200). Unpacking a huge
  ZIP is CPU-bound in the Worker, which is why `limits.cpu_ms` is raised.

### Using GitHub Desktop

1. In dropyard, open **Access tokens** (sidebar) and create a token for this
   computer. Copy it; it is shown once.
2. Open a project and press **Clone** to copy its URL
   (`https://<your-host>/git/<project>.git`), or press **Open in GitHub
   Desktop**.
3. In GitHub Desktop choose **File → Clone repository → URL**, paste the URL,
   and when it asks for credentials enter your email as the username and the
   token as the password.

Commit and push as usual. Pushes to the default branch are fast-forward only;
an admin can mark it **protected** in project settings, which makes changes go
through a pull request with an approving review.

An existing project with releases but no history yet shows an **Import
releases** card on its Code tab: it turns the published releases into tagged
commits, oldest first, without copying any file data in R2.

Limits worth knowing: Cloudflare caps a request body at 100 MB on the Free and
Pro plans (500 MB on Business), so a single push must stay under that. Push
large changes in several commits. The very first clone of an imported project
downloads the whole library, which can be many GB, and Git cannot resume a
broken clone. For those, use **Clone → resumable starter download**: the panel
prepares a git bundle you download in the browser (with resume), clone from it
locally, then point `origin` back at dropyard so later fetches are small.

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

Local note 2: RAR unpacking works locally too — create a `.dev.vars` file
containing `EXTRACT_CALLBACK_SECRET=dev-secret`, keep Docker running, and
`wrangler dev` will build the container image on first RAR upload. ZIP
unpacking needs no extra setup anywhere.

## FiveM server side

Copy [`scripts/updater/`](scripts/updater/) to the server.

PowerShell (Windows / txAdmin):

```powershell
.\dropyard-updater.ps1 -BaseUrl https://dropyard.yourteam.workers.dev `
  -Token gctx_xxx -Slug server-artifacts -Dest C:\fxserver\artifacts
```

Linux (bash + `curl` only, nothing to copy). The server hands out the pull
script with the origin and slug baked in:

```bash
curl -fsSL -H "Authorization: Bearer gctx_xxx" \
  https://dropyard.yourteam.workers.dev/dl/server-artifacts/pull.sh | DEST=/srv/fxserver/resources bash
```

It mirrors the release: only new or changed files are downloaded, files the
previous release had but this one dropped are deleted, and anything else in
`DEST` is left alone (state lives in `DEST/.gitctx/`). `FORCE=1` re-downloads
everything. [`dropyard-updater.sh`](scripts/updater/dropyard-updater.sh) wraps the
same thing with env vars for cron.

Whole release as one file: `GET /dl/<slug>/latest?format=zip` streams a zip
(ZIP64, stored) built on the fly from R2; multi-file releases get the zip
without the flag.

Both updaters check a digest first — nothing downloads when the release
hasn't changed, so they're safe in a cron or txAdmin schedule.

## How it fits together

```
web/dist (Vite React SPA)
   │  static assets served by the Worker
   ▼
src/index.ts (Hono)
   ├── /api/auth/*      sessions, invites, first-run setup
   ├── /api/projects/*  projects, releases, publish, machine manifest
   ├── /api/uploads/*   upload sessions: presigned parts + single-stream
   ├── /api/internal/*  extraction container callbacks (shared-secret auth)
   ├── /api/admin/*     members, invites, tokens, audit, webhook
   ├── /api/projects/:slug/repo/*   tree, blobs, commits, compare, web commits, import
   ├── /api/projects/:slug/issues|pulls/*  issues, pull requests, reviews, comments
   ├── /api/me/tokens   personal access tokens for git
   ├── /git/<slug>.git/*  Git smart HTTP (upload-pack v0/v2, receive-pack)
   ├── /dl/*            streaming downloads from R2 (Range + ETag support)
   └── D1 metadata, R2 objects at p/<project>/r/<release>/<path>
```

Uploads above ~90 MB never pass through the Worker: the browser PUTs 64 MB
parts directly to R2 using presigned URLs (each part carries a SHA-256 that
R2 verifies), which is why a 6 GB MLO survives a flaky connection — done
parts are listed from R2 on resume.

Archives take a detour on completion: a `.zip` is stream-extracted inside the
Worker (fflate, entries written straight back to R2), while a `.rar` is handed
to the `dropyard-extract` container (7-Zip), which downloads the volume set from
R2, unpacks, uploads each file and reports progress back over
`/api/internal/extract`.

Git objects live beside the release files: trees and commits sit in D1
(`git_objects`, `git_commits`), blobs in R2 at `p/<project>/git/<sha>`.
Imported blobs reuse the release files' existing R2 keys, and deleting a
release never removes an object that a commit still references. Pushed packs
are parsed as a stream, so a large blob goes straight to R2 without being
held in memory.

## Upgrading an existing deployment

```bash
npx wrangler d1 migrations apply dropyard --remote   # adds 0004_git and 0005_collab
npm run deploy
```

## Scripts

| Command           | What it does                                   |
| ----------------- | ---------------------------------------------- |
| `npm run dev`     | Worker locally on :8787                        |
| `npm run dev:web` | SPA dev server on :5173 (proxies the API)      |
| `npm run build`   | Build the SPA into `web/dist`                  |
| `npm run setup`   | Interactive first-time setup                   |
| `npm run deploy`  | Build + `wrangler deploy`                      |
| `npm test`        | Worker integration tests (vitest, miniflare)   |
| `npm run typecheck` | TypeScript for Worker and SPA                |

## Cost reality

R2 storage is $0.015/GB-month with **zero egress fees** — a 30 GB library is
about $0.45/month. Workers Paid ($5/month) is recommended for a team; the
chunked/presigned design also stays within the free plan's request limits if
you want to start there.

## Testing and security

`npm test` runs the whole suite inside workerd with local D1 and R2 (no cloud
account needed); CI runs typecheck, tests and a build on every pull request,
and [CodeQL](.github/workflows/codeql.yml) scans the code weekly and on every
pull request. Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). dropyard is released under the
[MIT license](LICENSE).
