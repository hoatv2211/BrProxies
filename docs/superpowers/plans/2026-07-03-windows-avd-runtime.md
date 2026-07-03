# Windows AVD Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real Windows Android runtime backed by Android Emulator/AVD, so BrProxies can create/start/open Android screens on Windows without fake runtime.

**Architecture:** Android Manager gains a runtime selector and dispatches lifecycle operations to runtime services. `windows_avd` wraps Android SDK CLI tools while preserving the existing HTTP API and SQLite model. Tauri writes runtime config from Settings, and React exposes the selector.

**Tech Stack:** Python FastAPI sidecar, SQLite, Android SDK CLI (`adb`, `emulator`, `avdmanager`, `scrcpy`), Tauri Rust settings/config bridge, React/TypeScript UI.

---

### Task 1: Runtime Config And Validation

**Files:**
- Modify: `android_manager/android_manager/config.py`
- Modify: `android_manager/android_manager/validator.py`
- Modify: `android_manager/tests/test_config.py`
- Modify: `android_manager/tests/test_api.py`

- [ ] Add failing tests that `runtime` loads from JSON/env and `/validate` reports runtime-aware requirements.
- [ ] Add `runtime: str = "redroid"` to `AndroidManagerConfig`.
- [ ] Support `ANDROID_MANAGER_RUNTIME` env.
- [ ] Change `validate_host(runtime)` to require tools per runtime.
- [ ] Update API `/validate` to call selected runtime.

### Task 2: Windows AVD Service

**Files:**
- Create: `android_manager/android_manager/avd_service.py`
- Create: `android_manager/tests/test_avd_service.py`

- [ ] Add failing tests for command construction: create AVD, start emulator, wait boot, stop, open scrcpy.
- [ ] Implement `AvdService` with injectable runner for tests.
- [ ] Resolve serial as `emulator-<console_port>` and keep console ports even, starting from configured `adb_port_start` rounded to even if needed.
- [ ] Return clear errors when SDK tools are missing.

### Task 3: Runtime Dispatch In API

**Files:**
- Modify: `android_manager/android_manager/api.py`
- Modify: `android_manager/tests/test_api.py`

- [ ] Add failing API lifecycle test for `runtime=windows_avd` with fake runner monkeypatch.
- [ ] Dispatch create/start/stop/delete/open-screen to `AvdService` when runtime is `windows_avd`.
- [ ] Keep existing fake and redroid behavior passing.

### Task 4: Tauri Settings Bridge

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/android.rs`

- [ ] Add `android_manager_runtime` setting defaulting to `windows_avd` on Windows and `redroid` elsewhere.
- [ ] Write `runtime` into Android Manager config JSON.
- [ ] Keep `fake_runtime` available but map fake mode to `runtime=fake` when enabled.

### Task 5: React Settings And Android UX

**Files:**
- Modify: `src/App.tsx`

- [ ] Add settings type field `android_manager_runtime`.
- [ ] Add Android runtime selector with options `windows_avd`, `redroid`, `fake`.
- [ ] Start behavior opens screen for real runtimes, warns only for fake.

### Task 6: Verification And Commit

**Commands:**
- `python -m pytest android_manager\tests -q`
- `npm.cmd run build`
- `cargo check` from `src-tauri` with `CARGO_TARGET_DIR` outside normal target if needed.
- `git status --short --untracked-files=all`
- Commit with `feat: add Windows AVD Android runtime`.
