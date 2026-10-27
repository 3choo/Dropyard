export function pullSnippets(base: string, slug: string): Array<{ id: string; label: string; code: string }> {
  return [
    {
      id: 'linux',
      label: 'Linux',
      code: `# Mirror the latest release of "${slug}" into DEST (bash + curl, no jq).
# Downloads only new/changed files and deletes files the release dropped;
# anything you put there yourself is left alone. Re-run any time.
curl -fsSL \\
  -H "Authorization: Bearer gctx_YOUR_DEPLOY_TOKEN" \\
  "${base}/dl/${slug}/pull.sh" | DEST=/srv/fxserver/resources bash

# Files come straight from R2, 128 at a time. FORCE=1 re-downloads everything,
# PARALLEL=256 opens more connections.`,
    },
    {
      id: 'download',
      label: 'Direct download',
      code: `# Whole release as one zip, streamed straight from R2
curl -fL -o release.zip \\
  -H "Authorization: Bearer gctx_YOUR_DEPLOY_TOKEN" \\
  "${base}/dl/${slug}/latest?format=zip"

unzip -o release.zip -d /srv/fxserver/resources
# no unzip? apt install unzip, or: python3 -m zipfile -e release.zip /srv/fxserver/resources`,
    },
    {
      id: 'check',
      label: 'Version check',
      code: `# Cheap poll — compare digest before downloading anything
curl -fsS \\
  -H "Authorization: Bearer gctx_YOUR_DEPLOY_TOKEN" \\
  "${base}/api/projects/${slug}/releases/latest/check"`,
    },
    {
      id: 'ps',
      label: 'PowerShell',
      code: `# Pull the latest release of "${slug}" into a target folder
$BASE   = "${base}"
$TOKEN  = "gctx_YOUR_DEPLOY_TOKEN"
$SLUG   = "${slug}"
$DEST   = "C:\\path\\to\\resources"
$H      = @{ Authorization = "Bearer $TOKEN" }

$rel = Invoke-RestMethod "$BASE/api/projects/$SLUG/releases/latest" -Headers $H
foreach ($f in $rel.files) {
  $out = Join-Path $DEST ($f.path -replace '/', '\\')
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  Invoke-WebRequest "$BASE$($f.downloadUrl)" -Headers $H -OutFile $out
  Write-Host "pulled $($f.path)"
}
Write-Host "now at v$($rel.version)"`,
    },
  ];
}
