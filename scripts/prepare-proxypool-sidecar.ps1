param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$serviceRoot = Join-Path $repoRoot "proxypool_service"
$venvRoot = Join-Path $serviceRoot ".build-venv"
$buildPython = Join-Path $venvRoot "Scripts\python.exe"
$resourceRoot = Join-Path $repoRoot "src-tauri\resources\proxypool"
$pyInstallerRoot = Join-Path $serviceRoot ".pyinstaller"
$entryPoint = Join-Path $serviceRoot "sidecar_entry.py"
$redisSource = Join-Path $repoRoot "redis\redis-server.exe"
$redisDestination = Join-Path $resourceRoot "redis\redis-server.exe"
$dependencyStamp = Join-Path $venvRoot ".brproxies-build-dependencies"

function Invoke-Checked {
  param(
    [string]$Command,
    [string[]]$Arguments
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Command failed with exit code $LASTEXITCODE"
  }
}

function Get-Sha256 {
  param([string]$Path)

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return (($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) -join "")
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
  throw "ProxyPool sidecar entry point is missing: $entryPoint"
}
if (-not (Test-Path -LiteralPath $redisSource -PathType Leaf)) {
  throw "Bundled Redis server is missing: $redisSource"
}

if (-not (Test-Path -LiteralPath $buildPython -PathType Leaf)) {
  Write-Host "Creating ProxyPool build environment..."
  Invoke-Checked -Command $Python -Arguments @("-m", "venv", $venvRoot)
}

$dependencyHash = Get-Sha256 (Join-Path $serviceRoot "pyproject.toml")
$installedHash = if (Test-Path -LiteralPath $dependencyStamp) {
  (Get-Content -LiteralPath $dependencyStamp -Raw).Trim()
} else {
  ""
}
if ($installedHash -ne $dependencyHash) {
  Write-Host "Installing ProxyPool build dependencies..."
  Invoke-Checked -Command $buildPython -Arguments @(
    "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
    "-e", "$serviceRoot[build]"
  )
  Set-Content -LiteralPath $dependencyStamp -Value $dependencyHash -Encoding ASCII
}

New-Item -ItemType Directory -Force -Path $resourceRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $pyInstallerRoot "spec") | Out-Null

Write-Host "Freezing ProxyPool sidecar..."
Invoke-Checked -Command $buildPython -Arguments @(
  "-m", "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onefile",
  "--exclude-module", "pkg_resources",
  "--exclude-module", "setuptools",
  "--name", "brproxies-proxypool",
  "--paths", $serviceRoot,
  "--distpath", $resourceRoot,
  "--workpath", (Join-Path $pyInstallerRoot "work"),
  "--specpath", (Join-Path $pyInstallerRoot "spec"),
  $entryPoint
)

$sidecar = Join-Path $resourceRoot "brproxies-proxypool.exe"
if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
  throw "PyInstaller did not create the ProxyPool sidecar: $sidecar"
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $redisDestination) | Out-Null
Copy-Item -LiteralPath $redisSource -Destination $redisDestination -Force

$manifest = [ordered]@{
  schema_version = 1
  sidecar = "brproxies-proxypool.exe"
  sidecar_sha256 = (Get-Sha256 $sidecar).ToLowerInvariant()
  redis = "redis/redis-server.exe"
  redis_sha256 = (Get-Sha256 $redisDestination).ToLowerInvariant()
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resourceRoot "manifest.json") -Encoding UTF8

Write-Host "ProxyPool release resources ready: $resourceRoot"
