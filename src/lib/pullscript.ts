export function pullScript(base: string, slug: string, token: string): string {
  return SCRIPT.replace('__BASE__', shQuote(base)).replace('__SLUG__', shQuote(slug)).replace('__TOKEN__', shQuote(token));
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const SCRIPT = String.raw`#!/usr/bin/env bash
# dropyard pull: mirror the latest published release into a folder.
#   DEST      target folder (default: first argument, else the current directory)
#   FORCE=1   re-download every file, even unchanged ones
#   PARALLEL  concurrent downloads (default 128; curl caps it at 300)
#   DEBUG=1   trace every command
set -euo pipefail
export LC_ALL=C

BASE_URL=__BASE__
SLUG=__SLUG__
TOKEN=${'$'}{GITCTX_TOKEN:-__TOKEN__}
DEST=${'$'}{DEST:-${'$'}{1:-$PWD}}
FORCE=${'$'}{FORCE:-0}
PARALLEL=${'$'}{PARALLEL:-128}
[ "${'$'}{DEBUG:-0}" = 1 ] && set -x

started=$SECONDS
log() { printf '[dropyard %4ds] %s\n' "$((SECONDS - started))" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
human() {
  awk -v b="$1" 'BEGIN { split("B KB MB GB TB", u); i = 1
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}
[ -n "$TOKEN" ] || die "set GITCTX_TOKEN to a deploy token (gctx_...)"
command -v curl >/dev/null || die "curl is required"

mkdir -p "$DEST"
DEST=$(cd "$DEST" && pwd)
STATE_DIR="$DEST/.gitctx"
STATE="$STATE_DIR/$SLUG.manifest"
mkdir -p "$STATE_DIR"
log "pulling '$SLUG' from $BASE_URL"
log "into $DEST"

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

log "fetching the release file list (big releases can take a minute server-side)..."
curl -fsS --retry 3 -K "$work/auth.cfg" -o "$work/new" "$BASE_URL/dl/$SLUG/latest/manifest" \
  || die "could not fetch the release manifest from $BASE_URL"
version=$(sed -n 's/^#version //p' "$work/new")
digest=$(sed -n 's/^#digest //p' "$work/new")
[ -n "$version" ] || die "unexpected manifest response"

old_digest=""
old_version=""
if [ -f "$STATE" ]; then
  old_digest=$(sed -n 's/^#digest //p' "$STATE")
  old_version=$(sed -n 's/^#version //p' "$STATE")
fi

{ grep -v '^#' "$work/new" || true; } | sort -u > "$work/new.list"
total_files=$(wc -l < "$work/new.list" | tr -d ' ')
total_bytes=$(awk -F '\t' '{ s += $2 } END { printf "%.0f", s }' "$work/new.list")
log "release v$version: $total_files files, $(human "$total_bytes")"
if [ -n "$old_version" ]; then
  log "last pull here was v$old_version"
else
  log "first pull into this folder: everything will be downloaded"
fi

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

count=0
bytes=0
seen=0
# Builtins only in these loops (no subshells) — they run once per file.
queue() {
  local enc=$1 size=$2 path
  printf -v path '%b' "${'$'}{enc//%/\\x}"
  safe_path "$path" || { echo "dropyard: skipping unsafe path $enc" >&2; return 0; }
  printf '%s\n' "$enc"
  printf '%s\n' "$path" >&3
  count=$((count + 1))
  bytes=$((bytes + size))
}
# One curl config entry: download <url> into DEST/<path>.gitctx-part.
emit() {
  local enc=$1 url=$2 path out
  printf -v path '%b' "${'$'}{enc//%/\\x}"
  out="$DEST/$path.gitctx-part"
  out=${'$'}{out//\\/\\\\}
  out=${'$'}{out//\"/\\\"}
  printf 'url = "%s"\noutput = "%s"\n' "$url" "$out"
}
tick() {
  seen=$((seen + 1))
  if [ $((seen % 2000)) -eq 0 ]; then
    printf '\r[dropyard %4ds] checking files: %d/%d' "$((SECONDS - started))" "$seen" "$total_files" >&2
  fi
}

log "checking which files need downloading..."
exec 3>> "$parts"
{
  while IFS=$'\t' read -r _ size enc; do
    tick
    [ -n "$enc" ] && queue "$enc" "$size"
  done < "$work/changed"
  # Unchanged entries are only fetched again if they went missing locally.
  while IFS=$'\t' read -r _ size enc; do
    tick
    [ -n "$enc" ] || continue
    printf -v path '%b' "${'$'}{enc//%/\\x}"
    [ -f "$DEST/$path" ] || queue "$enc" "$size"
  done < "$work/same"
} > "$work/want"
exec 3>&-
[ "$seen" -ge 2000 ] && printf '\n' >&2

removed=$(wc -l < "$work/removed" | tr -d ' ')
log "plan: download $count file(s) ($(human "$bytes")), keep $((total_files - count)) unchanged, remove $removed"
if [ "$count" -eq 0 ] && [ "$removed" -eq 0 ] && [ "$digest" = "$old_digest" ]; then
  log "$SLUG already at v$version, nothing to do"
  exit 0
fi

if [ "$count" -gt 0 ]; then
  # One request for every signed R2 link, so the downloads themselves never
  # touch the Worker (a per-file Worker round trip capped throughput).
  log "requesting $count download links..."
  code=$(curl -sS --retry 3 -K "$work/auth.cfg" -X POST -H 'content-type: text/plain' \
    --data-binary @"$work/want" -o "$work/links" -w '%{http_code}' \
    "$BASE_URL/dl/$SLUG/v/$version/links") || code=000
  if [ "$code" = 200 ]; then
    linked=$({ grep -c . "$work/links" || true; })
    [ "$linked" -eq "$count" ] || die "server returned $linked links for $count files"
    # No auth header here: R2 rejects a request carrying a second auth mechanism.
    while IFS=$'\t' read -r enc url; do
      [ -n "$url" ] && emit "$enc" "$url"
    done < "$work/links" > "$work/fetch.cfg"
    mode="straight from storage"
  else
    log "direct links unavailable (HTTP $code); falling back to per-file downloads through the Worker (slower)"
    cp "$work/auth.cfg" "$work/fetch.cfg"
    while IFS= read -r enc; do
      emit "$enc" "$BASE_URL/dl/$SLUG/v/$version?direct=1&path=$enc"
    done < "$work/want" >> "$work/fetch.cfg"
    mode="through the Worker"
  fi
  par=()
  if curl --parallel -V >/dev/null 2>&1; then
    par=(--parallel --parallel-immediate --parallel-max "$PARALLEL")
    log "downloading $mode, $PARALLEL at a time (live progress below)..."
  else
    log "downloading $mode one file at a time (this curl has no --parallel; upgrade curl for speed)..."
  fi
  dl_start=$SECONDS
  curl -fSL --retry 3 --create-dirs ${'$'}{par[@]+"${'$'}{par[@]}"} -K "$work/fetch.cfg" || die "download failed; nothing was changed"
  dl_secs=$((SECONDS - dl_start))
  [ "$dl_secs" -gt 0 ] || dl_secs=1
  log "downloaded $(human "$bytes") in ${'$'}{dl_secs}s ($(human $((bytes / dl_secs)))/s)"
  log "moving $count file(s) into place..."
  while IFS= read -r p; do
    mv -f -- "$DEST/$p.gitctx-part" "$DEST/$p"
  done < "$parts"
  : > "$parts"
fi

if [ "$removed" -gt 0 ]; then
  log "removing $removed file(s) the new release dropped..."
fi
while IFS= read -r enc; do
  printf -v path '%b' "${'$'}{enc//%/\\x}"
  safe_path "$path" || continue
  log "  removed $path"
  [ -d "$DEST/$path" ] || rm -f -- "$DEST/$path"
  d=$path
  while [[ $d == */* ]]; do
    d=${'$'}{d%/*}
    rmdir -- "$DEST/$d" 2>/dev/null || break
  done
done < "$work/removed"

cp "$work/new" "$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"
log "done: $SLUG is now at v$version ($count downloaded, $removed removed) in $((SECONDS - started))s"
log "restart the server if resources changed."
`;
