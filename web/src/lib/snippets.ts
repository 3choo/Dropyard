export function pullSnippets(base: string, slug: string): Array<{ id: string; label: string; code: string }> {
  return [
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
    {
      id: 'check',
      label: 'Version check',
      code: `# Cheap poll — compare digest before downloading anything
curl -s \\
  -H "Authorization: Bearer gctx_YOUR_DEPLOY_TOKEN" \\
  "${base}/api/projects/${slug}/releases/latest/check"`,
    },
    {
      id: 'download',
      label: 'Direct download',
      code: `# Single-file releases stream straight from R2 via the Worker
curl -L -o release.zip \\
  -H "Authorization: Bearer gctx_YOUR_DEPLOY_TOKEN" \\
  "${base}/dl/${slug}/latest"`,
    },
  ];
}
