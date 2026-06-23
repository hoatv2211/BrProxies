# Chrome Extension Live Proxy Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Chrome extension show and rotate only proxies that pass a fresh ProxyPool live check.

**Architecture:** Keep ProxyPool storage unchanged. The backend exposes running job state through `/health.jobs`; the extension background service worker triggers `POST /jobs/check`, polls `/health` until `jobs.check` is no longer running, then reloads `/proxies?https=false` and filters out records with `fail_count > 0`.

**Tech Stack:** Chrome Manifest V3, plain JavaScript popup/background, BrProxies ProxyPool API.

---

### Task 1: ProxyPool Job Status

**Files:**
- Modify: `proxypool_service/proxypool_service/api.py`

- [x] Add a `jobs` object to `/health` with running background job names so clients can wait for `/jobs/check` without comparing result payloads.

### Task 2: Background Live Check

**Files:**
- Modify: `extension/background.js`

- [x] Add `fetchJson(apiUrl, path, options)` support so the extension can call `POST /jobs/check`.
- [x] Add `liveProxies(records)` to keep records with a non-empty `proxy` and `fail_count === 0`.
- [x] Add `testLivePool(apiUrl)` to store the URL, trigger `/jobs/check`, poll `/health.jobs`, and return filtered proxies plus total count.
- [x] Change `connect` to return live-filtered proxies.
- [x] Change `rotateProxy` to choose from live-filtered `/proxies` records and fail with `No live proxy available. Run Test live first.` when none exist.

### Task 3: Popup Controls

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.css`
- Modify: `extension/popup.js`

- [x] Add a `Test live` button next to `Connect`, `Rotate`, and `Direct`.
- [x] Resize action grid to four equal columns.
- [x] Add popup-side live filtering for display safety.
- [x] Add status text in the form `Tested - 29/33 live`.
- [x] Hide dead rows and show `No live proxies available` when nothing passes.

### Task 4: Docs And Verification

**Files:**
- Modify: `extension/README.md`

- [x] Document `Connect` versus `Test live` behavior.
- [x] Run `npm.cmd run test:extension`.
- [x] Run `node --check extension\background.js`.
- [x] Run `node --check extension\popup.js`.
- [x] Run `uv run --project proxypool_service --extra dev pytest proxypool_service\tests -q`.
- [x] Run `git diff --check`.
