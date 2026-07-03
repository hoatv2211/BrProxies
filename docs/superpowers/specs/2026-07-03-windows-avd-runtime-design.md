# Windows AVD Runtime Design

## Goal

BrProxies must be able to create and start a real Android instance on Windows without relying on fake runtime. The first real Windows runtime is Android Emulator/AVD. ReDroid remains the Linux-host path for later, and `external_adb` remains a later attach-only option.

## Scope

- Add Android Manager runtime selection: `windows_avd`, `redroid`, `fake`.
- Default to `windows_avd` on Windows-side development/config when the user wants real Android.
- Use Android SDK tools already installed on the machine: `adb`, `emulator`, `avdmanager`, `sdkmanager` optional for validation, and `scrcpy`.
- Keep the existing Android Manager HTTP API shape so the Tauri UI can keep using `/instances`, `/start`, `/stop`, `/screenshot`, `/open-screen`, `/install-apk`, `/set-proxy`, and `/clear-proxy`.
- Store enough metadata in the existing SQLite columns to start/stop an AVD instance: `container_name` becomes the runtime instance handle (`brproxies_<slug>_<port>`), and `adb_port` maps to emulator console port plus one for ADB serial behavior.

## Runtime Behavior

`windows_avd` creates an AVD name per BrProxies instance and starts it with `emulator.exe -avd <name> -port <console_port> -no-snapshot-save`. The manager waits for ADB boot completion before marking it running. `open-screen` launches `scrcpy -s emulator-<console_port> --no-audio`.

If `avdmanager` or a usable system image is missing, creation returns a clear setup error instead of silently creating a fake instance. If an AVD already exists, create reuses it. Stop uses `adb -s emulator-<console_port> emu kill`.

## Validation

Validation becomes runtime-aware:

- `windows_avd`: requires `adb`, `emulator`, `avdmanager`, `scrcpy`; `sdkmanager` is informational.
- `redroid`: requires `docker`, `adb`, binder devices; `scrcpy` is recommended.
- `fake`: always usable and reports that no real Android window will open.

## UI

Settings add an Android runtime selector. The fake toggle remains available but is treated as a debug runtime. Android tab host status should reflect the selected runtime. Pressing `Start` on a Windows AVD instance starts the emulator and opens the screen.

## Non-Goals

- Downloading Android SDK automatically.
- Running ReDroid through Docker Desktop on Windows.
- Managing Google Play images, GPU tuning, or full template import/export in this phase.
- Attaching MuMu/LDPlayer/BlueStacks in this phase.

## Test Plan

- Unit tests for config loading and runtime selection.
- Unit tests using monkeypatched subprocess calls for `windows_avd` create/start/stop/open-screen command construction.
- API lifecycle test with `windows_avd` service fakes.
- Existing fake/runtime tests remain passing.
- Frontend build verifies settings/UI types.
