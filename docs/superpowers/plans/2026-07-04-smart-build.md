# Smart Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add smart cached builds for `smart launch\build.bat`.

**Architecture:** Keep the existing batch file as the user-facing entrypoint and move cache/hash logic into a focused PowerShell helper. Store per-step hashes under `.brproxies-build-cache` so unchanged steps can be skipped, and use Tauri CLI for release exe builds so frontend assets are embedded correctly.

**Tech Stack:** Windows batch, PowerShell 5+, npm, Python venv, Cargo/Tauri.

---

### Task 1: Build Wrapper

**Files:**
- Modify: `smart launch/build.bat`
- Create: `smart launch/smart-build.ps1`

- [ ] **Step 1: Replace `build.bat` with a wrapper**

`build.bat` should call `smart-build.ps1` from the same directory and pass through arguments.

- [ ] **Step 2: Add PowerShell helper**

`smart-build.ps1` should parse `/full`, `/deps`, `-Full`, and `-Deps`, check required tools, compute file hashes, and run only needed steps.

- [ ] **Step 3: Verify syntax**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File "smart launch\smart-build.ps1" -Help`

Expected: usage text with `/full` and `/deps`.

### Task 2: Build Verification

**Files:**
- Test: `smart launch/build.bat`

- [ ] **Step 1: Run smart build**

Run: `& "smart launch\build.bat"`

Expected: unchanged dependency steps print `Skipping ...`, changed steps build, and output ends with `Build complete.`

- [ ] **Step 2: Run full build if cache behavior looks wrong**

Run: `& "smart launch\build.bat" /full`

Expected: all steps run and output exe exists at `src-tauri\target\release\brproxies.exe`.

### Self-Review

Spec coverage: wrapper, cache, modes, error handling, and verification are covered.

Placeholder scan: no placeholders remain.

Type consistency: command names and paths match the spec.
