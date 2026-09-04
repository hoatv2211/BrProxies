$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("brproxies-proxypool-integration-{0}" -f [guid]::NewGuid())
$redisDir = Join-Path $tempRoot "redis-data"
$sidecarDir = Join-Path $tempRoot "sidecar-data"
$redis = $null
$sidecar = $null

New-Item -ItemType Directory -Force -Path $redisDir, $sidecarDir | Out-Null
try {
  $redis = Start-Process -FilePath (Join-Path $repoRoot "redis\redis-server.exe") `
    -ArgumentList @("--bind", "127.0.0.1", "--protected-mode", "yes", "--port", "6399", "--requirepass", "integration", "--dir", $redisDir, "--dbfilename", "integration.rdb", "--appendonly", "no") `
    -WorkingDirectory $redisDir -WindowStyle Hidden -PassThru

  $redisCli = Join-Path $repoRoot "redis\redis-cli.exe"
  $redisReady = $false
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $pong = (& $redisCli -h 127.0.0.1 -p 6399 -a integration ping 2>$null).Trim()
      if ($pong -eq "PONG") { $redisReady = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 100
  }
  if (-not $redisReady) { throw "Bundled Redis did not become ready" }

  $config = Join-Path $sidecarDir "config.json"
  [ordered]@{
    host = "127.0.0.1"
    port = 40426
    redis_url = "redis://:integration@127.0.0.1:6399/0"
    initial_collect = $false
    collect_interval_seconds = 900
    check_interval_seconds = 300
    timeout_seconds = 1
    max_concurrency = 2
    disabled_sources = @()
    custom_sources = @()
    failure_threshold = 2
  } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8

  $sidecar = Start-Process -FilePath (Join-Path $repoRoot "src-tauri\resources\proxypool\brproxies-proxypool.exe") `
    -ArgumentList @("serve", "--config", $config) `
    -WorkingDirectory (Join-Path $repoRoot "src-tauri\resources\proxypool") -WindowStyle Hidden -PassThru

  $health = $null
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:40426/health" -TimeoutSec 1
      if ($health.ok -eq $true) { break }
    } catch {}
    Start-Sleep -Milliseconds 100
  }
  if ($null -eq $health -or $health.ok -ne $true) {
    throw "Packaged ProxyPool health failed"
  }
  Write-Output ("PACKAGED_PROXYPOOL_HEALTH=" + ($health | ConvertTo-Json -Compress))
  Write-Output "PACKAGED_PROXYPOOL_INTEGRATION=PASS"
} finally {
  if ($sidecar) {
    Stop-Process -Id $sidecar.Id -Force -ErrorAction SilentlyContinue
    $sidecar.WaitForExit()
  }
  if ($redis) {
    Stop-Process -Id $redis.Id -Force -ErrorAction SilentlyContinue
    $redis.WaitForExit()
  }
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
