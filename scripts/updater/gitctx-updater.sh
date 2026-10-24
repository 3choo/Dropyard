#!/usr/bin/env bash
# Pull the latest release of a gitctx project onto a FiveM server (Linux).
# Needs curl and jq. Repeat runs are cheap: a digest check precedes any download.
#
#   BASE_URL=https://gitctx.example.workers.dev \
#   TOKEN=gctx_xxx SLUG=server-artifacts DEST=/srv/fxserver/artifacts \
#   ./gitctx-updater.sh
set -euo pipefail

BASE_URL="${BASE_URL:?set BASE_URL to your gitctx origin}"
TOKEN="${TOKEN:?set TOKEN to a deploy token (gctx_...)}"
SLUG="${SLUG:?set SLUG to the project slug}"
DEST="${DEST:?set DEST to the target folder}"
FORCE="${FORCE:-0}"

AUTH="Authorization: Bearer $TOKEN"
STATE="$DEST/gitctx-state.json"

check=$(curl -fsS -H "$AUTH" "$BASE_URL/api/projects/$SLUG/releases/latest/check") || {
  echo "gitctx: cannot reach $BASE_URL" >&2
  exit 1
}
remote_digest=$(printf '%s' "$check" | jq -r .digest)
remote_version=$(printf '%s' "$check" | jq -r .version)
known_digest=""
[ -f "$STATE" ] && known_digest=$(jq -r .digest "$STATE" 2>/dev/null || true)

if [ "$FORCE" != "1" ] && [ "$remote_digest" = "$known_digest" ]; then
  echo "gitctx: $SLUG already at v$remote_version"
  exit 0
fi

echo "gitctx: pulling v$remote_version of $SLUG..."
manifest=$(curl -fsS -H "$AUTH" "$BASE_URL/api/projects/$SLUG/releases/latest")
mkdir -p "$DEST"

printf '%s' "$manifest" | jq -r '.files[].path' | while IFS= read -r path; do
  out="$DEST/$path"
  mkdir -p "$(dirname "$out")"
  url=$(printf '%s' "$manifest" | jq -r --arg p "$path" '.files[] | select(.path == $p) | .downloadUrl')
  curl -fsS -H "$AUTH" -o "$out" "$BASE_URL$url"
  echo "  pulled $path"
done

printf '{"version":"%s","digest":"%s","pulledAt":"%s"}\n' \
  "$remote_version" "$remote_digest" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE"

echo "gitctx: $SLUG is now at v$remote_version — restart the server if resources changed."
