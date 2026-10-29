#!/usr/bin/env bash
# Pull the latest release of a dropyard project onto a FiveM server (Linux).
# Needs only bash and curl. Thin wrapper around the pull script the server
# serves at /dl/<slug>/pull.sh — it mirrors the release into DEST, downloading
# only changed files and deleting files the release dropped.
#
#   BASE_URL=https://dropyard.example.workers.dev \
#   TOKEN=gctx_xxx SLUG=server-artifacts DEST=/srv/fxserver/resources \
#   ./dropyard-updater.sh
#
# FORCE=1 re-downloads everything; PARALLEL sets concurrent downloads (default 8).
set -euo pipefail

BASE_URL="${BASE_URL:?set BASE_URL to your dropyard origin}"
TOKEN="${TOKEN:?set TOKEN to a deploy token (gctx_...)}"
SLUG="${SLUG:?set SLUG to the project slug}"
DEST="${DEST:?set DEST to the target folder}"

script=$(curl -fsSL -H "Authorization: Bearer $TOKEN" "$BASE_URL/dl/$SLUG/pull.sh") || {
  echo "dropyard: cannot fetch the pull script from $BASE_URL" >&2
  exit 1
}
GITCTX_TOKEN="$TOKEN" DEST="$DEST" bash -c "$script"
