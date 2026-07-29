param(
  [switch]$Full,
  [switch]$Deps,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

foreach ($arg in $args) {
  switch -Regex ($arg) {
    '^/(full|rebuild)$' { $Full = $true; continue }
    '^/(deps)$' { $Deps = $true; continue }
    '^/(h|help|\?)$' { $Help = $true; continue }
    default { throw "Unknown argument: $arg" }
  }
}

if ($Help) {
  Write-Host "Usage: smart launch\build.bat [/full] [/deps]"
  Write-Host "  default  Smart cached build"
  Write-Host "  /full    Force all build steps"
  Write-Host "  /deps    Force npm and Android Manager dependency setup"
  exit 0
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
  $env:PATH = "$cargoBin;$env:PATH"
}

function Require-Command($Name, $Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "Missing $Name in PATH."
    Write-Host $Hint
    exit 1
  }
}

function Get-ExistingFileList($Paths) {
  $files = New-Object System.Collections.Generic.List[string]
  foreach ($path in $Paths) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $item = Get-Item -LiteralPath $path
    if ($item.PSIsContainer) {
      Get-ChildItem -LiteralPath $path -Recurse -File | ForEach-Object {
        $full = $_.FullName
        if ($full -match '\\(node_modules|dist|target|\.venv|__pycache__|\.brproxies-build-cache|\.git)\\') { return }
        $files.Add($full)
      }
    } else {
      $files.Add($item.FullName)
    }
  }
  $files | Sort-Object -Unique
}

function Get-InputHash($Paths) {
  $files = @(Get-ExistingFileList $Paths)
  if ($files.Count -eq 0) { return "empty" }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $builder = New-Object System.Text.StringBuilder
  $rootUri = New-Object System.Uri(($repoRoot.Path.TrimEnd('\\') + '\\'))
  foreach ($file in $files) {
    $fileUri = New-Object System.Uri($file)
    $relative = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($fileUri).ToString())
    $fileHash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    [void]$builder.AppendLine("$relative=$fileHash")
  }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($builder.ToString())
  $hashBytes = $sha.ComputeHash($bytes)
  -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
}

function Get-Cache($Name) {
  $path = Join-Path $cacheDir "$Name.hash"
  if (Test-Path -LiteralPath $path) { return (Get-Content -LiteralPath $path -Raw).Trim() }
  return ""
}

function Set-Cache($Name, $Hash) {
  $path = Join-Path $cacheDir "$Name.hash"
  Set-Content -LiteralPath $path -Value $Hash -Encoding ASCII
}

function Run-Step($Title, $Command, $Arguments, $WorkingDirectory = $repoRoot.Path) {
  Write-Host ""
  Write-Host $Title
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Test-FileWritable($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  try {
    $stream = [System.IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
    $stream.Close()
    return $true
  } catch {
    return $false
  }
}

function Stop-LockingBrProxies($Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $target = (Resolve-Path -LiteralPath $Path).Path
  $locked = @(Get-Process -Name "brproxies" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -eq $target } catch { $false }
  })
  if ($locked.Count -eq 0) { return }
  Write-Host "Closing running BrProxies before build..."
  foreach ($process in $locked) {
    Stop-Process -Id $process.Id -Force
  }
  for ($i = 0; $i -lt 50; $i++) {
    if (Test-FileWritable $Path) { return }
    Start-Sleep -Milliseconds 100
  }
}

Require-Command "cargo" "Install Rust from https://rustup.rs/ then reopen terminal or VS Code."
Require-Command "rustc" "Install Rust from https://rustup.rs/ then reopen terminal or VS Code."
Require-Command "npm.cmd" "Install Node.js LTS, then reopen terminal or VS Code."
Require-Command "python" "Install Python 3.11+ from https://www.python.org/downloads/ then reopen terminal or VS Code."

Write-Host "Building BrProxies..."
if ($Full) { Write-Host "Mode: full" } elseif ($Deps) { Write-Host "Mode: smart + deps refresh" } else { Write-Host "Mode: smart" }

$cacheDir = Join-Path $repoRoot ".brproxies-build-cache"
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

$androidVenv = "android_manager\.venv"
$androidPython = Join-Path $repoRoot "$androidVenv\Scripts\python.exe"

$npmHash = Get-InputHash @("package.json", "package-lock.json")
$androidDepsHash = Get-InputHash @("android_manager\pyproject.toml")
$frontendHash = Get-InputHash @("src", "index.html", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.node.json", "vite.config.ts")
$tauriHash = Get-InputHash @("src-tauri\src", "src-tauri\build.rs", "src-tauri\Cargo.toml", "src-tauri\Cargo.lock", "src-tauri\tauri.conf.json", "src-tauri\tauri.windows.conf.json", "src-tauri\capabilities", "automation", "scripts\prepare-account-keeper-worker.mjs", "smart launch\build.bat", "smart launch\smart-build.ps1")

$needNpm = $Full -or $Deps -or -not (Test-Path -LiteralPath "node_modules") -or ((Get-Cache "npm") -ne $npmHash)
if ($needNpm) {
  Run-Step "Installing npm dependencies..." "npm.cmd" @("install")
  $npmHash = Get-InputHash @("package.json", "package-lock.json")
  Set-Cache "npm" $npmHash
} else {
  Write-Host "Skipping npm dependencies; package files unchanged."
}

$frontendHash = Get-InputHash @("src", "index.html", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.node.json", "vite.config.ts")

$needAndroidVenv = -not (Test-Path -LiteralPath $androidPython)
if ($needAndroidVenv) {
  Run-Step "Creating Android Manager Python venv..." "python" @("-m", "venv", $androidVenv)
}

$needAndroidDeps = $Full -or $Deps -or $needAndroidVenv -or ((Get-Cache "android-manager") -ne $androidDepsHash)
if ($needAndroidDeps) {
  Run-Step "Installing Android Manager dependencies..." $androidPython @("-m", "pip", "install", "--no-build-isolation", "-e", "android_manager[dev]")
  Set-Cache "android-manager" $androidDepsHash
} else {
  Write-Host "Skipping Android Manager dependencies; pyproject unchanged."
}

$needFrontend = $Full -or -not (Test-Path -LiteralPath "dist\index.html") -or ((Get-Cache "frontend") -ne $frontendHash)

$exePath = "src-tauri\target\release\brproxies.exe"
$needDesktop = $Full -or $needFrontend -or -not (Test-Path -LiteralPath $exePath) -or ((Get-Cache "tauri") -ne $tauriHash)
if ($needDesktop) {
  Stop-LockingBrProxies $exePath
  if (-not (Test-FileWritable $exePath)) {
    throw "BrProxies is still locking $exePath. Close it manually, then run smart launch\build.bat again."
  }
  Run-Step "Building desktop app..." "npm.cmd" @("run", "tauri", "build", "--", "--no-bundle")
  $frontendHash = Get-InputHash @("src", "index.html", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.node.json", "vite.config.ts")
  $tauriHash = Get-InputHash @("src-tauri\src", "src-tauri\build.rs", "src-tauri\Cargo.toml", "src-tauri\Cargo.lock", "src-tauri\tauri.conf.json", "src-tauri\tauri.windows.conf.json", "src-tauri\capabilities", "automation", "scripts\prepare-account-keeper-worker.mjs", "smart launch\build.bat", "smart launch\smart-build.ps1")
  Set-Cache "frontend" $frontendHash
  Set-Cache "tauri" $tauriHash
} else {
  Write-Host "Skipping web assets; frontend inputs unchanged."
  Write-Host "Skipping desktop app; Tauri/Rust inputs unchanged."
}

Write-Host ""
Write-Host "Build complete."
Write-Host "Output: src-tauri\target\release\brproxies.exe"
