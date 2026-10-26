/**
 * The Linux pull script served at /dl/<slug>/pull.sh, with the origin, slug
 * and (when fetched with a deploy token) the token baked in, so a server
 * mirrors a release with one line:
 *
 *   curl -fsSL -H "Authorization: Bearer gctx_..." https://<origin>/dl/<slug>/pull.sh | DEST=/srv/fx/resources bash
 *
 * Needs only bash, curl and coreutils. It reads /dl/<slug>/latest/manifest
 * (one "<fingerprint>\t<size>\t<url-encoded path>" line per file), keeps the
 * last pulled copy in $DEST/.gitctx/<slug>.manifest, downloads entries that are
 * new, changed or missing locally, and deletes files the previous release had
 * but this one dropped. Files it never pulled are left alone.
 */
export function pullScript(base: string, slug: string, token: string): string {
  return SCRIPT.replace('__BASE__', shQuote(base)).replace('__SLUG__', shQuote(slug)).replace('__TOKEN__', shQuote(token));
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const SCRIPT = String.raw`#!/usr/bin/env bash
# gitctx pull: mirror the latest published release into a folder.
#   DEST      target folder (default: first argument, else the current directory)
#   FORCE=1   re-download every file, even unchanged ones
#   PARALLEL  concurrent downloads (default 8)
set -euo pipefail
export LC_ALL=C

BASE_URL=__BASE__
SLUG=__SLUG__
TOKEN=${'$'}{GITCTX_TOKEN:-__TOKEN__}
DEST=${'$'}{DEST:-${'$'}{1:-$PWD}}
FORCE=${'$'}{FORCE:-0}
PARALLEL=${'$'}{PARALLEL:-8}

die() { echo "gitctx: $*" >&2; exit 1; }
[ -n "$TOKEN" ] || die "set GITCTX_TOKEN to a deploy token (gctx_...)"
command -v curl >/dev/null || die "curl is required"

mkdir -p "$DEST"
DEST=$(cd "$DEST" && pwd)
STATE_DIR="$DEST/.gitctx"
STATE="$STATE_DIR/$SLUG.manifest"
mkdir -p "$STATE_DIR"

work=$(mktemp -d)
parts="$work/parts"
: > "$parts"
cleanup() {
  # Leave no half-written files behind if a download failed.
  while IFS= read -r p; do rm -f -- "$DEST/$p.gitctx-part"; done < "$parts"
  rm -rf "$work"
}
trap cleanup EXIT

# The token goes through a curl config file so it never shows up in ps.
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" > "$work/auth.cfg"

curl -fsS --retry 3 -K "$work/auth.cfg" -o "$work/new" "$BASE_URL/dl/$SLUG/latest/manifest" \
  || die "could not fetch the release manifest from $BASE_URL"
version=$(sed -n 's/^#version //p' "$work/new")
digest=$(sed -n 's/^#digest //p' "$work/new")
[ -n "$version" ] || die "unexpected manifest response"

old_digest=""
[ -f "$STATE" ] && old_digest=$(sed -n 's/^#digest //p' "$STATE")

{ grep -v '^#' "$work/new" || true; } | sort -u > "$work/new.list"
if [ -f "$STATE" ] && [ "$FORCE" != 1 ]; then
  { grep -v '^#' "$STATE" || true; } | sort -u > "$work/old.list"
else
  : > "$work/old.list"
fi
comm -13 "$work/old.list" "$work/new.list" > "$work/changed"
comm -12 "$work/old.list" "$work/new.list" > "$work/same"
if [ -f "$STATE" ]; then
  { grep -v '^#' "$STATE" || true; } | cut -f3 | sort -u > "$work/old.paths"
else
  : > "$work/old.paths"
fi
cut -f3 "$work/new.list" | sort -u > "$work/new.paths"
comm -23 "$work/old.paths" "$work/new.paths" > "$work/removed"

# Paths arrive percent-encoded; refuse anything that could leave DEST.
safe_path() {
  case "/$1/" in
    *'/../'* | *'/./'* | *'//'* | *$'\n'*) return 1 ;;
  esac
  [ -n "$1" ]
}
cfg_escape() {
  local s=${'$'}{1//\\/\\\\}
  printf '%s' "${'$'}{s//\"/\\\"}"
}

cp "$work/auth.cfg" "$work/fetch.cfg"
count=0
bytes=0
queue() {
  local enc=$1 size=$2 path
  printf -v path '%b' "${'$'}{enc//%/\\x}"
  safe_path "$path" || { echo "gitctx: skipping unsafe path $enc" >&2; return 0; }
  printf 'url = "%s"\noutput = "%s"\n' \
    "$BASE_URL/dl/$SLUG/v/$version?path=$enc" "$(cfg_escape "$DEST/$path.gitctx-part")" >> "$work/fetch.cfg"
  printf '%s\n' "$path" >> "$parts"
  count=$((count + 1))
  bytes=$((bytes + size))
}

while IFS=$'\t' read -r _ size enc; do
  [ -n "$enc" ] && queue "$enc" "$size"
done < "$work/changed"
# Unchanged entries are only fetched again if they went missing locally.
while IFS=$'\t' read -r _ size enc; do
  [ -n "$enc" ] || continue
  printf -v path '%b' "${'$'}{enc//%/\\x}"
  [ -f "$DEST/$path" ] || queue "$enc" "$size"
done < "$work/same"

removed=$(wc -l < "$work/removed" | tr -d ' ')
if [ "$count" -eq 0 ] && [ "$removed" -eq 0 ] && [ "$digest" = "$old_digest" ]; then
  echo "gitctx: $SLUG already at v$version"
  exit 0
fi

if [ "$count" -gt 0 ]; then
  echo "gitctx: pulling v$version of $SLUG: $count file(s), $bytes bytes"
  par=()
  curl --parallel -V >/dev/null 2>&1 && par=(--parallel --parallel-max "$PARALLEL")
  curl -fsS --retry 3 --create-dirs ${'$'}{par[@]+"${'$'}{par[@]}"} -K "$work/fetch.cfg" || die "download failed; nothing was changed"
  while IFS= read -r p; do
    mv -f -- "$DEST/$p.gitctx-part" "$DEST/$p"
  done < "$parts"
  : > "$parts"
fi

while IFS= read -r enc; do
  printf -v path '%b' "${'$'}{enc//%/\\x}"
  safe_path "$path" || continue
  [ -d "$DEST/$path" ] || rm -f -- "$DEST/$path"
  d=$path
  while [[ $d == */* ]]; do
    d=${'$'}{d%/*}
    rmdir -- "$DEST/$d" 2>/dev/null || break
  done
done < "$work/removed"

cp "$work/new" "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
echo "gitctx: $SLUG is now at v$version ($count downloaded, $removed removed). Restart the server if resources changed."
`;
