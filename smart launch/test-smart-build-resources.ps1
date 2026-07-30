$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot "smart-build.ps1"
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $scriptPath,
  [ref]$tokens,
  [ref]$errors
)
if ($errors.Count -gt 0) { throw $errors[0].Message }

$definition = $ast.Find({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq "Sync-AccountKeeperResources"
}, $true)
if (-not $definition) { throw "Missing function: Sync-AccountKeeperResources" }
Invoke-Expression $definition.Extent.Text

$syncCalls = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.CommandAst] -and
    $node.GetCommandName() -eq "Sync-AccountKeeperResources"
}, $true))
if ($syncCalls.Count -eq 0) { throw "Smart build does not stage Account Keeper resources" }

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("brproxies-resource-test-{0}" -f [guid]::NewGuid())
$source = Join-Path $tempRoot "source"
$destination = Join-Path $tempRoot "release/account-keeper"

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $source "node") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $source "worker/node_modules/patchright") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $source "worker/node_modules/patchright-core") | Out-Null
  Set-Content -LiteralPath (Join-Path $source "manifest.json") -Value '{"schema_version":1}' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $source "node/node.exe") -Value "node" -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $source "worker/account-keeper-worker.mjs") -Value "worker-v1" -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $source "worker/node_modules/patchright/package.json") -Value '{}' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $source "worker/node_modules/patchright-core/package.json") -Value '{}' -Encoding ASCII

  Sync-AccountKeeperResources -Source $source -Destination $destination
  foreach ($relative in @(
    "manifest.json",
    "node/node.exe",
    "worker/account-keeper-worker.mjs",
    "worker/node_modules/patchright/package.json",
    "worker/node_modules/patchright-core/package.json"
  )) {
    if (-not (Test-Path -LiteralPath (Join-Path $destination $relative))) {
      throw "Missing staged resource: $relative"
    }
  }

  Set-Content -LiteralPath (Join-Path $source "manifest.json") -Value '{"schema_version":2}' -Encoding ASCII
  Set-Content -LiteralPath (Join-Path $source "worker/account-keeper-worker.mjs") -Value "worker-v2" -Encoding ASCII
  Sync-AccountKeeperResources -Source $source -Destination $destination
  if ((Get-Content -LiteralPath (Join-Path $destination "worker/account-keeper-worker.mjs") -Raw).Trim() -ne "worker-v2") {
    throw "Outdated Account Keeper resources were not refreshed"
  }
} finally {
  if ($tempRoot.StartsWith([System.IO.Path]::GetTempPath(), [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "smart-build resource tests passed"
