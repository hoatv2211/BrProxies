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

foreach ($name in @("Test-FileWritable", "Wait-FileWritable", "Test-BrProxiesProcessTarget")) {
  $definition = $ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
      $node.Name -eq $name
  }, $true)
  if (-not $definition) { throw "Missing function: $name" }
  Invoke-Expression $definition.Extent.Text
}

$tempPath = Join-Path ([System.IO.Path]::GetTempPath()) ("brproxies-lock-test-{0}.tmp" -f [guid]::NewGuid())
$readyPath = "$tempPath.ready"
Set-Content -LiteralPath $tempPath -Value "test" -Encoding ASCII

function Start-ExclusiveHolder($Path, $Milliseconds) {
  Start-Job -ScriptBlock {
    param($FilePath, $HoldMilliseconds)
    $stream = [System.IO.File]::Open($FilePath, "Open", "ReadWrite", "None")
    try {
      Start-Sleep -Milliseconds $HoldMilliseconds
    } finally {
      $stream.Dispose()
    }
  } -ArgumentList $Path, $Milliseconds
}

function Wait-UntilLocked($Path) {
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if (-not (Test-FileWritable $Path)) { return }
    Start-Sleep -Milliseconds 25
  }
  throw "Holder did not lock test file"
}

try {
  $sharedReader = Start-Job -ScriptBlock {
    param($FilePath, $ReadyFilePath)
    $stream = [System.IO.File]::Open(
      $FilePath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    )
    try {
      Set-Content -LiteralPath $ReadyFilePath -Value "ready" -Encoding ASCII
      Start-Sleep -Seconds 5
    } finally {
      $stream.Dispose()
    }
  } -ArgumentList $tempPath, $readyPath
  for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $readyPath); $attempt++) {
    Start-Sleep -Milliseconds 25
  }
  if (-not (Test-Path -LiteralPath $readyPath)) { throw "Shared reader did not start" }
  if (-not (Test-FileWritable $tempPath)) {
    throw "Test-FileWritable rejected a reader that allows write/delete sharing"
  }
  Stop-Job $sharedReader
  Wait-Job $sharedReader | Out-Null
  Remove-Job $sharedReader
  Remove-Item -LiteralPath $readyPath -Force

  $releasedHolder = Start-ExclusiveHolder $tempPath 750
  Wait-UntilLocked $tempPath
  $probeState = [pscustomobject]@{ Count = 0 }
  if (-not (Wait-FileWritable -Path $tempPath -TimeoutSeconds 3 -PollMilliseconds 50 -BeforeProbe {
    $probeState.Count += 1
  })) {
    throw "Wait-FileWritable did not survive a transient lock"
  }
  if ($probeState.Count -lt 2) {
    throw "Wait-FileWritable did not repeat its lock callback"
  }
  Wait-Job $releasedHolder | Out-Null
  Remove-Job $releasedHolder

  $timedOutHolder = Start-ExclusiveHolder $tempPath 1500
  Wait-UntilLocked $tempPath
  if (Wait-FileWritable -Path $tempPath -TimeoutSeconds 0.2 -PollMilliseconds 50) {
    throw "Wait-FileWritable ignored its timeout"
  }
  Wait-Job $timedOutHolder | Out-Null
  Remove-Job $timedOutHolder

  $exactProcess = [pscustomobject]@{ Path = $tempPath }
  $unknownProcess = [pscustomobject]@{ Path = $null }
  $otherProcess = [pscustomobject]@{ Path = Join-Path ([System.IO.Path]::GetTempPath()) "other-brproxies.exe" }
  if (-not (Test-BrProxiesProcessTarget -Process $exactProcess -TargetPath $tempPath)) {
    throw "Exact BrProxies process path was not selected"
  }
  if (-not (Test-BrProxiesProcessTarget -Process $unknownProcess -TargetPath $tempPath)) {
    throw "BrProxies process with an unreadable path was not selected"
  }
  if (Test-BrProxiesProcessTarget -Process $otherProcess -TargetPath $tempPath) {
    throw "Different BrProxies process path was selected"
  }
} finally {
  Get-Job | Where-Object { $_.State -ne "Completed" } | Stop-Job -ErrorAction SilentlyContinue
  Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
}

Write-Host "smart-build lock tests passed"
