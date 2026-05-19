$ErrorActionPreference = "Stop"

Set-Location -LiteralPath $PSScriptRoot

$nodeDir = "C:\Program Files\nodejs"
$npm = Join-Path $nodeDir "npm.cmd"
$node = Join-Path $nodeDir "node.exe"

if (-not (Test-Path -LiteralPath $npm) -or -not (Test-Path -LiteralPath $node)) {
  Write-Host "Node.js/npm was not found at $nodeDir. Install Node.js, then run this launcher again."
  Read-Host "Press Enter to exit"
  exit 1
}

$env:PATH = "$nodeDir;$env:PATH"

if (-not (Test-Path -LiteralPath "node_modules")) {
  & $npm install --cache .\.npm-cache
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Dependency install failed."
    Read-Host "Press Enter to exit"
    exit $LASTEXITCODE
  }
}

& $npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed."
  Read-Host "Press Enter to exit"
  exit $LASTEXITCODE
}

Start-Process "http://localhost:4317"
& $node server\index.mjs
Read-Host "Press Enter to exit"
