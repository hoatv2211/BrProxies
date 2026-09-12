import { normalizeLoopbackApiUrl } from "./codex-export.js";
import { connectAndExportCodex } from "./codex-oauth.js";

const DEFAULT_POOL_API_URL = "http://127.0.0.1:40326";
const DEFAULT_BRPROXIES_API_URL = "http://127.0.0.1:40325";

function normalizePoolApiUrl(apiUrl) {
  return normalizeLoopbackApiUrl(apiUrl, DEFAULT_POOL_API_URL);
}

async function fetchJson(apiUrl, path, options = {}) {
  const base = normalizePoolApiUrl(apiUrl);
  const response = await fetch(`${base}${path}`, { cache: "no-store", ...options });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchAuthorizedJson(apiUrl, token, path, options = {}) {
  const base = normalizeLoopbackApiUrl(apiUrl, DEFAULT_BRPROXIES_API_URL);
  const response = await fetch(`${base}${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error) message = body.error;
    } catch {
      // The auth middleware deliberately returns an empty 401 response.
    }
    throw new Error(message);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function liveProxies(records) {
  return (Array.isArray(records) ? records : []).filter((record) => {
    const proxy = String(record?.proxy || "").trim();
    const failCount = Number(record?.fail_count || 0);
    return proxy && failCount === 0;
  });
}

async function waitForJob(apiUrl, jobName) {
  const deadline = Date.now() + 600000;
  let health = await fetchJson(apiUrl, "/health");
  while (Date.now() < deadline) {
    if (health?.jobs?.[jobName] !== "running") {
      return { health, timedOut: false };
    }
    await sleep(1500);
    health = await fetchJson(apiUrl, "/health");
  }
  return { health, timedOut: true };
}

async function loadPool(apiUrl, liveOnly = true) {
  const [health, records] = await Promise.all([
    fetchJson(apiUrl, "/health"),
    fetchJson(apiUrl, "/proxies?https=false")
  ]);
  const proxies = liveOnly ? liveProxies(records) : records;
  return { apiUrl, health, proxies, total: Array.isArray(records) ? records.length : 0 };
}

async function testLivePool(apiUrl) {
  const normalized = normalizePoolApiUrl(apiUrl);
  await storageSet({ apiUrl: normalized });
  const job = await fetchJson(normalized, "/jobs/check", { method: "POST" });
  const { health, timedOut } = await waitForJob(normalized, job.job || "check");
  const records = await fetchJson(normalized, "/proxies?https=false");
  const proxies = liveProxies(records);
  return { apiUrl: normalized, health, proxies, total: Array.isArray(records) ? records.length : 0, timedOut };
}

function storageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(items);
    });
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function storageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function sessionGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(keys, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(items);
    });
  });
}

function sessionSet(items) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function sessionRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.session.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function resolveBrProxiesToken(candidate) {
  const supplied = String(candidate || "").trim();
  if (supplied) return supplied;
  const stored = await sessionGet("brApiToken");
  const token = String(stored.brApiToken || "").trim();
  if (!token) {
    throw new Error("Paste the Automation API Bearer token first");
  }
  return token;
}

async function connectCodexExport(apiUrl, candidateToken) {
  const normalized = normalizeLoopbackApiUrl(apiUrl, DEFAULT_BRPROXIES_API_URL);
  const suppliedToken = String(candidateToken || "").trim();
  const token = await resolveBrProxiesToken(candidateToken);
  const profiles = await fetchAuthorizedJson(
    normalized,
    token,
    "/account-keeper/profiles"
  );
  if (suppliedToken) await sessionSet({ brApiToken: suppliedToken });
  await storageSet({ brApiUrl: normalized });
  return { apiUrl: normalized, profiles, hasToken: true };
}

async function exportCodexAccounts(message) {
  const apiUrl = normalizeLoopbackApiUrl(message.apiUrl, DEFAULT_BRPROXIES_API_URL);
  const suppliedToken = String(message.token || "").trim();
  const token = await resolveBrProxiesToken(message.token);
  const profileIds = Array.from(
    new Set((Array.isArray(message.profileIds) ? message.profileIds : []).map(String).filter(Boolean))
  );
  if (profileIds.length === 0) {
    throw new Error("Select at least one Codex profile");
  }
  if (!new Set(["nine_router", "cockpit"]).has(message.format)) {
    throw new Error("Unsupported Codex export format");
  }
  const result = await fetchAuthorizedJson(apiUrl, token, "/account-keeper/codex/export", {
    method: "POST",
    body: JSON.stringify({ profileIds, format: message.format })
  });
  if (suppliedToken) await sessionSet({ brApiToken: suppliedToken });
  return result;
}

function tabsCreate(details) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(details, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(tab);
    });
  });
}

function trustedCodexAuthorizeUrl(value) {
  const url = new URL(String(value || ""));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.openai.com" ||
    url.pathname !== "/oauth/authorize"
  ) {
    throw new Error("BrProxies returned an invalid Codex authorization URL");
  }
  return url.toString();
}

async function connectAndExportCodexAccounts(message) {
  const apiUrl = normalizeLoopbackApiUrl(message.apiUrl, DEFAULT_BRPROXIES_API_URL);
  const token = await resolveBrProxiesToken();
  await storageSet({ brApiUrl: apiUrl });
  return connectAndExportCodex({
    profileIds: message.profileIds,
    format: message.format,
    listProfiles: () =>
      fetchAuthorizedJson(apiUrl, token, "/account-keeper/profiles"),
    startOAuth: (profileId) =>
      fetchAuthorizedJson(apiUrl, token, "/account-keeper/codex/oauth", {
        method: "POST",
        body: JSON.stringify({ profileId })
      }),
    openAuthorization: (authorizeUrl) =>
      tabsCreate({ url: trustedCodexAuthorizeUrl(authorizeUrl), active: true }),
    readOAuth: (operationId) =>
      fetchAuthorizedJson(
        apiUrl,
        token,
        `/account-keeper/codex/oauth/${encodeURIComponent(operationId)}`
      ),
    exportAccounts: (profileIds, format) =>
      fetchAuthorizedJson(apiUrl, token, "/account-keeper/codex/export", {
        method: "POST",
        body: JSON.stringify({ profileIds, format })
      })
  });
}

function proxySettingsSet(details) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.set(details, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function proxySettingsClear(details) {
  return new Promise((resolve, reject) => {
    chrome.proxy.settings.clear(details, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function parseProxy(record) {
  const raw = String(record?.proxy || "").trim();
  const withoutScheme = raw.includes("://") ? raw.split("://", 2)[1] : raw;
  const hostPort = withoutScheme.split("/", 1)[0];
  const parts = hostPort.split(":");
  const host = String(record?.host || parts.slice(0, -1).join(":")).trim();
  const port = Number(record?.port || parts[parts.length - 1]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid proxy record");
  }
  return { raw: raw || `${host}:${port}`, host, port };
}

async function setChromeProxy(record) {
  const proxy = parseProxy(record);
  await proxySettingsSet({
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
  await storageSet({ activeProxy: proxy.raw });
  return { activeProxy: proxy.raw };
}

async function clearChromeProxy() {
  await proxySettingsClear({ scope: "regular" });
  await storageRemove("activeProxy");
  return { activeProxy: null };
}

async function handleMessage(message) {
  if (message?.type === "connect") {
    const apiUrl = normalizePoolApiUrl(message.apiUrl);
    await storageSet({ apiUrl });
    return loadPool(apiUrl, true);
  }
  if (message?.type === "testLive") {
    return testLivePool(message.apiUrl);
  }
  if (message?.type === "setProxy") {
    return setChromeProxy(message.proxy);
  }
  if (message?.type === "rotateProxy") {
    const records = await fetchJson(message.apiUrl, "/proxies?https=false");
    const candidates = liveProxies(records);
    if (candidates.length === 0) {
      throw new Error("No live proxy available. Run Test live first.");
    }
    const record = candidates[Math.floor(Math.random() * candidates.length)];
    return setChromeProxy(record);
  }
  if (message?.type === "clearProxy") {
    return clearChromeProxy();
  }
  if (message?.type === "connectCodexExport") {
    return connectCodexExport(message.apiUrl, message.token);
  }
  if (message?.type === "exportCodex") {
    return exportCodexAccounts(message);
  }
  if (message?.type === "connectAndExportCodex") {
    return connectAndExportCodexAccounts(message);
  }
  if (message?.type === "forgetCodexToken") {
    await sessionRemove("brApiToken");
    return { hasToken: false };
  }
  if (message?.type === "getState") {
    const [local, session] = await Promise.all([
      storageGet(["apiUrl", "activeProxy", "brApiUrl"]),
      sessionGet("brApiToken")
    ]);
    return { ...local, hasBrApiToken: Boolean(session.brApiToken) };
  }
  throw new Error("Unknown message type");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
