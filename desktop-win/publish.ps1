# Build a slim Windows pack (requires .NET 8 Desktop Runtime on the target PC).
# Output: ..\dist\Cipher\
#   Cipher.exe           (framework-dependent — not self-contained)
#   app\                 (Node server + UI)
#   node\node.exe        (portable Node — no install required)
#   libvlc\win-x64\      (x64 only)
#   config\playlists.json
#   config\layout.ini
#   data\                (created on first run)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root 'dist\Cipher'
$NodeVersion = 'v22.14.0'
$NodeZipName = "node-$NodeVersion-win-x64"
$NodeUrl = "https://nodejs.org/dist/$NodeVersion/$NodeZipName.zip"
$Cache = Join-Path $env:TEMP "cipher-publish"
$NodeZip = Join-Path $Cache "$NodeZipName.zip"
$NodeExtract = Join-Path $Cache $NodeZipName

Write-Host "==> Publishing .NET framework-dependent win-x64 (needs .NET 8 Desktop Runtime)"
if (Test-Path $Out) { Remove-Item $Out -Recurse -Force }
dotnet publish (Join-Path $PSScriptRoot 'Cipher.csproj') `
  -c Release -r win-x64 --self-contained false `
  -p:PublishSingleFile=false `
  -p:DebugType=none `
  -p:DebugSymbols=false `
  -p:SatelliteResourceLanguages=en `
  -o $Out
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Trimming publish output (x86 libvlc, cultures, pdb/xml)"
$x86 = Join-Path $Out 'libvlc\win-x86'
if (Test-Path $x86) { Remove-Item $x86 -Recurse -Force }
Get-ChildItem $Out -Directory | Where-Object {
  $_.Name -match '^(cs|de|es|fr|it|ja|ko|pl|pt-BR|ru|tr|zh-Hans|zh-Hant)$'
} | Remove-Item -Recurse -Force
Get-ChildItem $Out -Recurse -Include *.pdb, *.xml -File -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "==> Copying app server"
$AppSrc = Join-Path $Root 'app'
$AppDst = Join-Path $Out 'app'
if (Test-Path $AppDst) { Remove-Item $AppDst -Recurse -Force }
New-Item -ItemType Directory -Path $AppDst | Out-Null

# Skip build junk, caches, and anything not needed at runtime.
$excludeDirs = @('node_modules', 'data', 'cache', '.git', 'scripts', 'bin', 'obj', '.vscode')
$excludeFiles = @('app.rar', '*.rar', '*.zip', '*.log', '*.db', '*.db-journal')
Get-ChildItem $AppSrc -Force | ForEach-Object {
  if ($_.PSIsContainer -and ($excludeDirs -contains $_.Name)) { return }
  if (-not $_.PSIsContainer) {
    foreach ($pat in $excludeFiles) {
      if ($_.Name -like $pat) { return }
    }
  }
  Copy-Item $_.FullName -Destination (Join-Path $AppDst $_.Name) -Recurse -Force
}

Write-Host "==> npm ci (production) in bundled app"
Push-Location $AppDst
try {
  npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { npm install --omit=dev }
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} finally {
  Pop-Location
}

Write-Host "==> Pruning fat JS packages (keep only runtime dist files)"
function Keep-DistFiles([string]$PkgDir, [string[]]$KeepNames) {
  if (-not (Test-Path $PkgDir)) { return }
  $dist = Join-Path $PkgDir 'dist'
  if (-not (Test-Path $dist)) { return }
  Get-ChildItem $dist -File | Where-Object { $KeepNames -notcontains $_.Name } | Remove-Item -Force
  # Drop source maps / demos / docs next to the package.
  Get-ChildItem $PkgDir -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in '.map', '.md', '.ts' -or $_.Name -like '*.d.ts' } |
    Remove-Item -Force -ErrorAction SilentlyContinue
  foreach ($drop in @('src', 'examples', 'demo', 'docs', 'test', 'tests', '.github')) {
    $p = Join-Path $PkgDir $drop
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
  }
}
Keep-DistFiles (Join-Path $AppDst 'node_modules\hls.js') @('hls.min.js')
Keep-DistFiles (Join-Path $AppDst 'node_modules\mpegts.js') @('mpegts.js', 'mpegts.js.LICENSE.txt')
# sql.js resolve path: package main -> dist/sql-wasm.js (+ .wasm sibling)
Keep-DistFiles (Join-Path $AppDst 'node_modules\sql.js') @(
  'sql-wasm.js', 'sql-wasm.wasm', 'sql-wasm-browser.js', 'sql-wasm-browser.wasm'
)

Write-Host "==> Portable Node $NodeVersion"
New-Item -ItemType Directory -Path $Cache -Force | Out-Null
if (-not (Test-Path $NodeZip)) {
  Write-Host "Downloading $NodeUrl"
  Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip
}
if (-not (Test-Path (Join-Path $NodeExtract 'node.exe'))) {
  if (Test-Path $NodeExtract) { Remove-Item $NodeExtract -Recurse -Force }
  Expand-Archive -Path $NodeZip -DestinationPath $Cache -Force
}
$NodeDst = Join-Path $Out 'node'
if (Test-Path $NodeDst) { Remove-Item $NodeDst -Recurse -Force }
New-Item -ItemType Directory -Path $NodeDst | Out-Null
Copy-Item (Join-Path $NodeExtract 'node.exe') (Join-Path $NodeDst 'node.exe') -Force
foreach ($f in @('LICENSE', 'README.md')) {
  $src = Join-Path $NodeExtract $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $NodeDst $f) -Force }
}

Write-Host "==> Default config templates"
$Cfg = Join-Path $Out 'config'
New-Item -ItemType Directory -Path $Cfg -Force | Out-Null
$Playlists = Join-Path $Cfg 'playlists.json'
$Layout = Join-Path $Cfg 'layout.ini'
# Always ship empty config — never bake personal playlists into the portable pack.
@'
{
  "version": 1,
  "playlists": []
}
'@ | Set-Content -Path $Playlists -Encoding utf8
@'
; Cipher layout - edit freely, then restart the app.
; Add a [playlist:Your Name] section matching a playlist name from playlists.json.
'@ | Set-Content -Path $Layout -Encoding utf8

$Readme = Join-Path $Out 'README-PORTABLE.txt'
@'
Cipher - portable package (Windows x64)
=======================================

Requirements:
  - Windows 10/11 x64
  - .NET 8 Desktop Runtime:
      https://dotnet.microsoft.com/download/dotnet/8.0
    (install the "Desktop Runtime" for Windows x64)
  - WebView2 Runtime (usually already on Windows 11)

Run:  Cipher.exe

Edit anytime (then restart the app):
  config\playlists.json   - add playlist URLs / Xtream / MAG logins (ships empty)
  config\layout.ini       - group order, renames, hidden channels, favorites

Runtime data (cache, database, logs) lives in:
  data\

Give someone the whole Cipher folder (zip it). Node is bundled under node\.
'@ | Set-Content -Path $Readme -Encoding utf8

$mb = [math]::Round(((Get-ChildItem $Out -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host ""
Write-Host "Portable build ready ($mb MB):"
Write-Host "  $Out"
Write-Host "Zip that folder to distribute."
Write-Host "Target PCs need .NET 8 Desktop Runtime (not the SDK)."
