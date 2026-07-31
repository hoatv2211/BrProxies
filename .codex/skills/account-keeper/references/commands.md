# Commands

Run commands from the repository root unless noted.

## Inspect

```powershell
rg -n "runAccountFlow|openLogin|openPasswordChange|verifySignedIn" automation
rg -n "password_state|credential_state_unknown|last_verified_at" src-tauri/src -g "account_keeper*.rs"
git status --short
```

## Node Worker Tests

```powershell
Push-Location automation
npm.cmd test
Pop-Location
```

Run one focused Node test:

```powershell
node --test automation/tests/account-keeper-flow.test.mjs
node --test automation/tests/account-keeper-worker.test.mjs
```

## Frontend Tests And Build

```powershell
npm.cmd test -- src/account-keeper/model.test.ts src/account-keeper/AccountKeeper.test.tsx
npm.cmd run build
```

## Rust Tests

```powershell
Push-Location src-tauri
cargo test account_keeper --lib
Pop-Location
```

## Worker Bundle

Required after changing worker modules, adapter files, Patchright dependencies, Node runtime metadata, or packaging logic:

```powershell
npm.cmd run build:account-keeper-worker
```

## Synthetic Tauri QA

Use only synthetic fixture credentials:

```powershell
npm.cmd ci --prefix automation --ignore-scripts
npm.cmd run qa:account-keeper-tauri
```

## Safe Result Inspection

Do not print the full JSON. Inspect only non-secret terminal metadata in memory:

```powershell
$result = Get-Content -LiteralPath "account-keeper-result.json" -Raw | ConvertFrom-Json
$result.accounts | Select-Object status,password_state,last_verified_at
```

Confirm the file remains ignored and untracked:

```powershell
git check-ignore -v account-keeper-result.json
git ls-files -- account-keeper-result.json
```

## Final Checks

```powershell
git diff --check
git status --short
```

Review diffs for accidental credentials before reporting completion. Do not stage or commit `account-keeper-result.json`, vault files, input files, screenshots, or browser-profile data.

