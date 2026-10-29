# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated (user approved the implementation plan specifying it): Cloudflare Worker (Hono + TypeScript) serving a Vite/React SPA via Workers Static Assets, R2 for object storage, D1 for metadata. Chosen because uploads exceed 5 GB (browser-direct multipart to R2) and the team wants zero-egress distribution to their FiveM server.

## Users

A small FiveM server dev team (the owner plus teammates) with three roles: admin (manage members, tokens, delete anything), uploader (create projects and publish releases), viewer (read-only). A secondary machine user: the FiveM server itself, pulling releases via deploy tokens with an updater script. [Inferred from role selection: "Small dev team — accounts with roles (admin/uploader/viewer), invite-based signup."]

## Product Purpose

dropyard is the team's private GitHub replacement for server content: upload resources, MLOs/maps, vehicles, full server builds, and configs; every upload becomes an immutable versioned release with notes; any release can be browsed, downloaded, or rolled back to. Success means: a multi-GB MLO uploads reliably from a browser without starting over, and the game server always runs the release the team chose — pulled automatically over a stable, token-authenticated URL.

## Positioning

GitHub-like release UX purpose-built for huge binaries and machine consumption: resumable multi-GB browser uploads direct to object storage, immutable releases, and stable endpoints an updater script can poll forever. GitHub itself can't do this for the team: hard 2 GB push limits, git ceremony around binary blobs, and no pull endpoint a game server should call.

## Operating Context

- Content: FiveM resources/scripts, MLOs/maps/vehicles (frequently 100 MB–5 GB+ per asset), full server builds, configs/keys. Single uploads can exceed 5 GB.
- The FiveM server runs txAdmin on Windows; consumption is automated via shipped PowerShell + sh updater scripts polling a version endpoint.
- The team lives in Discord; publishing a release may optionally announce to a webhook.
- Deployed on Cloudflare: workers.dev subdomain first, custom domain attachable later in one step.
- Everything is private; sharing happens via scoped deploy tokens, not public pages.

## Capabilities and Constraints

Confirmed:
- Projects with releases (semver-ish versions, markdown notes, draft → publish, immutable once published, rollback = republish/pin an older release as latest).
- Uploads: drag & drop of files or whole folders; dual-mode engine — presigned multipart direct browser→R2 for large files, chunked through-Worker for small files and local dev; pause/resume across page reloads; automatic part retry.
- Downloads stream through the Worker from R2 (token checks + counting), no size cap.
- Machine API: light version check, release manifest JSON, stable download URLs; Bearer or `?token=` auth.
- Auth: email + password, D1-backed sessions, invite-based signup, login rate limiting.
- Git hosting: each project is a Git repo over smart HTTP, used from GitHub Desktop with a personal access token. Code tab, commits, diffs, branches, compare, web edits, pull requests (merge or squash, reviews, line comments, optional protected default branch requiring approval), issues and comments. Releases can be cut from a commit and get a `v<version>` tag on publish; published releases can be imported into tagged history.
- Deliberately not built: branch channels for the server, search, blame, activity feed, per-project permissions, labels.
- Constraints: a push must fit Cloudflare's request body cap (100 MB on Free/Pro); no public/community pages in v1, no on-the-fly zip bundling in v1 (serve files as uploaded).
- Undecided: none blocking v1. Turnstile on login is optional hardening; Discord webhook is optional and off by default.

## Brand Commitments

- Name: dropyard (user confirmed by accepting the "Both-ready" deployment option; no other name offered).
- User-pinned visual world: dark developer aesthetic — deep charcoal base, one vivid accent, code-inspired mono details, glass/depth layers; modern and clean, with purposeful animation. Binding; see DESIGN.md at finish and the surface brief's direction contract.

## Evidence on Hand

None — greenfield. All demo/showcase content authored during the build must be labeled synthetic and replaced with real project data by the team.

## Product Principles

1. Big files are first-class: the upload experience is the product; never make a 6 GB upload feel fragile or start over on failure.
2. The server is a user too: every human feature has a stable, scriptable, token-authenticated machine equivalent.
3. Releases are immutable truth: what was published is what gets downloaded, forever, until deliberately deleted by an admin.
4. Private by default: no public surface, no unauthenticated byte leaves R2.
5. Speed of the daily loop: land on the dashboard, know what changed, ship a release in under a minute.

## Accessibility & Inclusion

No product-specific standard established. Respect `prefers-reduced-motion` (the product leans on animation by design); keep keyboard navigation and visible focus throughout the app UI.
