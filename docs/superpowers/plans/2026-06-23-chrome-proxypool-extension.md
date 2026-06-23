# Chrome ProxyPool Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome extension that reads local BrProxies ProxyPool proxies and applies one proxy to Chrome.

**Architecture:** The extension lives in `extension/`. `background.js` owns ProxyPool fetches and Chrome proxy API calls. `popup.js` renders status, proxy rows, and actions through message passing.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, HTML, CSS, `chrome.proxy`, `chrome.storage`.

---

## File Structure

- Create `extension/manifest.json`: MV3 metadata, popup, service worker, permissions, local host permissions.
- Create `extension/background.js`: message router, Pool API fetch helpers, proxy normalization, proxy apply/clear functions.
- Create `extension/popup.html`: popup shell with API URL field, status, actions, proxy list.
- Create `extension/popup.css`: compact popup styling.
- Create `extension/popup.js`: UI state, storage load/save, render proxies, send messages.
- Create `extension/README.md`: load/use docs and limits.
- Create `extension/tests/validate-extension.mjs`: static validation for manifest and required files.
- Modify `README.md`, `README.vn.md`, `docs/index.html`: document extension local workflow.
- Modify root `package.json`: add `test:extension` script.

### Task 1: Static Validator

**Files:**
- Create: `extension/tests/validate-extension.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create validation script**

```js
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const extensionDir = path.join(root, "extension");
const manifestPath = path.join(extensionDir, "manifest.json");

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

if (!fs.existsSync(manifestPath)) {
  fail("extension/manifest.json missing");
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
  for (const permission of ["proxy", "storage"]) {
    if (!manifest.permissions?.includes(permission)) fail(`missing permission: ${permission}`);
  }
  for (const host of ["http://127.0.0.1:40326/*", "http://localhost:40326/*"]) {
    if (!manifest.host_permissions?.includes(host)) fail(`missing host permission: ${host}`);
  }
  for (const broad of ["http://*/*", "https://*/*", "<all_urls>"]) {
    if (manifest.host_permissions?.includes(broad)) fail(`broad host permission not allowed: ${broad}`);
  }
  if (manifest.background?.service_worker !== "background.js") fail("background service worker must be background.js");
  if (manifest.action?.default_popup !== "popup.html") fail("default popup must be popup.html");
}

for (const file of ["background.js", "popup.html", "popup.css", "popup.js", "README.md"]) {
  if (!fs.existsSync(path.join(extensionDir, file))) fail(`missing extension/${file}`);
}
```

- [ ] **Step 2: Add npm script**

```json
"test:extension": "node extension/tests/validate-extension.mjs"
```

- [ ] **Step 3: Run validator before extension exists**

Run: `npm.cmd run test:extension`

Expected: FAIL with `extension/manifest.json missing`.

### Task 2: Extension Core

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/background.js`

- [ ] **Step 1: Add manifest**

```json
{
  "manifest_version": 3,
  "name": "BrProxies ProxyPool",
  "version": "0.1.0",
  "description": "Use a local BrProxies ProxyPool proxy in Chrome.",
  "permissions": ["proxy", "storage"],
  "host_permissions": [
    "http://127.0.0.1:40326/*",
    "http://localhost:40326/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "BrProxies ProxyPool"
  }
}
```

- [ ] **Step 2: Add background service worker**

```js
const DEFAULT_API_URL = "http://127.0.0.1:40326";

function normalizeApiUrl(apiUrl) {
  const url = new URL(apiUrl || DEFAULT_API_URL);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Pool API URL must use http or https");
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(apiUrl, path) {
  const base = normalizeApiUrl(apiUrl);
  const response = await fetch(`${base}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function parseProxy(record) {
  const raw = String(record?.proxy || "").trim();
  const host = record?.host || raw.split(":")[0];
  const portValue = record?.port || raw.split(":").pop();
  const port = Number(portValue);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid proxy record");
  }
  return { raw, host, port };
}

async function setChromeProxy(record) {
  const proxy = parseProxy(record);
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: "http",
          host: proxy.host,
          port: proxy.port
        },
        bypassList: ["<local>"]
      }
    },
    scope: "regular"
  });
  await chrome.storage.local.set({ activeProxy: proxy.raw || `${proxy.host}:${proxy.port}` });
  return { activeProxy: proxy.raw || `${proxy.host}:${proxy.port}` };
}

async function clearChromeProxy() {
  await chrome.proxy.settings.clear({ scope: "regular" });
  await chrome.storage.local.remove("activeProxy");
  return { activeProxy: null };
}

async function handleMessage(message) {
  if (message?.type === "connect") {
    const apiUrl = normalizeApiUrl(message.apiUrl);
    await chrome.storage.local.set({ apiUrl });
    const [health, proxies] = await Promise.all([
      fetchJson(apiUrl, "/health"),
      fetchJson(apiUrl, "/proxies?https=false")
    ]);
    return { apiUrl, health, proxies };
  }
  if (message?.type === "setProxy") return setChromeProxy(message.proxy);
  if (message?.type === "rotateProxy") {
    const record = await fetchJson(message.apiUrl, "/proxy/random?https=false");
    return setChromeProxy(record);
  }
  if (message?.type === "clearProxy") return clearChromeProxy();
  if (message?.type === "getState") return chrome.storage.local.get(["apiUrl", "activeProxy"]);
  throw new Error("Unknown message type");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
```

- [ ] **Step 3: Run validator**

Run: `npm.cmd run test:extension`

Expected: FAIL listing missing popup/docs files.

### Task 3: Popup UI

**Files:**
- Create: `extension/popup.html`
- Create: `extension/popup.css`
- Create: `extension/popup.js`

- [ ] **Step 1: Add popup HTML/CSS/JS using exact controls from spec**

- [ ] **Step 2: Wire popup message calls**

Use `chrome.runtime.sendMessage` for `connect`, `setProxy`, `rotateProxy`, `clearProxy`, and `getState`.

- [ ] **Step 3: Run validator**

Run: `npm.cmd run test:extension`

Expected: FAIL only missing `extension/README.md`.

### Task 4: Docs

**Files:**
- Create: `extension/README.md`
- Modify: `README.md`
- Modify: `README.vn.md`
- Modify: `docs/index.html`

- [ ] **Step 1: Add extension README with load/use steps**
- [ ] **Step 2: Add docs section to root READMEs**
- [ ] **Step 3: Add docs site paragraph**

### Task 5: Verify

**Files:**
- No code change expected.

- [ ] **Step 1: Run extension validation**

Run: `npm.cmd run test:extension`

Expected: PASS, no output.

- [ ] **Step 2: Run frontend build**

Run: `npm.cmd run build`

Expected: PASS.

- [ ] **Step 3: Run ProxyPool tests**

Run: `uv run --project proxypool_service --extra dev pytest proxypool_service\tests -q`

Expected: PASS.

- [ ] **Step 4: Run diff whitespace check**

Run: `git diff --check`

Expected: no whitespace errors.

## Self-Review

- Spec coverage: local API URL, connect, list, use, rotate, direct, minimal permissions, docs, and static validation all mapped to tasks.
- Placeholder scan: no `TBD` or open requirement left.
- Type consistency: message names and storage keys match between background and popup plan.

