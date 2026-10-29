<#
.SYNOPSIS
  Pull the latest release of a dropyard project onto a FiveM server.

.DESCRIPTION
  Polls the version check endpoint, and only when the digest changed, downloads
  every file of the latest release into the destination folder. Keeps a local
  state file (gitctx-state.json) so repeated runs are cheap.

  Run it from a scheduled task, txAdmin scheduler batch, or by hand.

.PARAMETER BaseUrl
  Your dropyard origin, e.g. https://dropyard.yourteam.workers.dev

.PARAMETER Token
  A deploy token (Admin -> Deploy tokens). gctx_...

.PARAMETER Slug
  The project slug to pull.

.PARAMETER Dest
  Local folder that receives the files. Created if missing.

.EXAMPLE
  .\dropyard-updater.ps1 -BaseUrl https://dropyard.example.workers.dev `
      -Token gctx_xxx -Slug server-artifacts -Dest C:\fxserver\artifacts
#>
param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Slug,
  [Parameter(Mandatory = $true)][string]$Dest,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $Dest 'gitctx-state.json'
$H = @{ Authorization = "Bearer $Token" }

try {
  $check = Invoke-RestMethod "$BaseUrl/api/projects/$Slug/releases/latest/check" -Headers $H
} catch {
  Write-Host "dropyard: cannot reach $BaseUrl ($($_.Exception.Message))" -ForegroundColor Red
  exit 1
}

$known = $null
if (Test-Path $stateFile) {
  $known = (Get-Content $stateFile -Raw | ConvertFrom-Json).digest
}

if (-not $Force -and $known -eq $check.digest) {
  Write-Host "dropyard: $Slug already at v$($check.version)"
  exit 0
}

Write-Host "dropyard: pulling v$($check.version) of $Slug..."
$rel = Invoke-RestMethod "$BaseUrl/api/projects/$Slug/releases/latest" -Headers $H
New-Item -ItemType Directory -Force $Dest | Out-Null

foreach ($f in $rel.files) {
  $out = Join-Path $Dest ($f.path -replace '/', '\')
  New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
  Invoke-WebRequest "$BaseUrl$($f.downloadUrl)" -Headers $H -OutFile $out
  Write-Host "  pulled $($f.path)"
}

@{ version = $rel.version; digest = $rel.digest; pulledAt = (Get-Date -Format o) } |
  ConvertTo-Json | Set-Content $stateFile

Write-Host "dropyard: $Slug is now at v$($rel.version) — restart the server if resources changed." -ForegroundColor Green
