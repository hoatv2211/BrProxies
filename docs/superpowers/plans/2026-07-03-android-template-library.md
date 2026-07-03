# Android Template Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a metadata-only Android template library and make `Start manager` create a default runnable fake/real instance immediately when no instances exist.

**Architecture:** Keep templates in the React app as a small built-in catalog, reusing the existing Android Manager API for instance creation. Add one launcher setting for auto-create behavior. No new sidecar endpoints are needed.

**Tech Stack:** React/TypeScript, Tauri Rust settings, existing Android Manager FastAPI API, existing Vite/npm and cargo verification.

---

## File Map

- Modify `src/App.tsx`: add `AndroidTemplate` type/catalog, `AndroidTemplatesView`, sidebar item, auto-create flow in `AndroidView`, and settings checkbox.
- Modify `src/App.css`: add card/grid styles for Android templates.
- Modify `src-tauri/src/settings.rs`: add `android_auto_create_default_instance` setting defaulting to `true`.
- Test with `npm.cmd run build`, `python -m pytest android_manager\tests -q`, and `cargo check` in `src-tauri`.

---

### Task 1: Settings Field

- [x] Add `android_auto_create_default_instance: bool` to `Settings` in `src-tauri/src/settings.rs` with serde default helper returning `true`.
- [x] Add matching default in `load()` fallback.
- [x] Add optional field to TypeScript `Settings` type in `src/App.tsx`.

### Task 2: Template Catalog

- [x] Add `AndroidTemplate` type and `ANDROID_TEMPLATES` array in `src/App.tsx`.
- [x] Include default ReDroid template plus Xiaomi metadata and docker-android metadata cards.
- [x] Add helper `androidInstanceBodyFromTemplate(template)` returning `{ name, image }`.

### Task 3: Android Templates UI

- [x] Add `androidTemplates` section to `Section` union and sidebar `Library` group.
- [x] Add `AndroidTemplatesView` grouped by source/runtime.
- [x] `Use ->` should start Android Manager if needed, post `/instances` using selected template, toast success, and switch to Android tab.
- [x] Add CSS for `.android-template-grid`, `.android-template-card`, and compact metadata rows.

### Task 4: Auto-Create Flow

- [x] Replace `Start manager` handler in `AndroidView` with `startManagerAndMaybeCreateDefault`.
- [x] After `android_start`, read `/instances`; if empty and setting enabled, create default instance from `ANDROID_DEFAULT_TEMPLATE`.
- [x] Refresh table after start/create.
- [x] Add Settings checkbox for `Auto-create default Android after manager starts`.

### Task 5: Verification And Commit

- [x] Run `python -m pytest android_manager\tests -q`; expected pass.
- [x] Run `npm.cmd run build`; expected pass.
- [x] Run `cargo check` from `src-tauri` using `CARGO_TARGET_DIR=..\target-codex-check`; expected pass.
- [x] Commit changes with `feat: add Android template library`.

