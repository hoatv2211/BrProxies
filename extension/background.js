const DEFAULT_API_URL = "http://127.0.0.1:40326";

function normalizeApiUrl(apiUrl) {
  const url = new URL(apiUrl || DEFAULT_API_URL);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("Pool API URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(apiUrl, path, options = {}) {
  const base = normalizeApiUrl(apiUrl);
  const response = await fetch(`${base}${path}`, { cache: "no-store", ...options });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
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
  const normalized = normalizeApiUrl(apiUrl);
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
    const apiUrl = normalizeApiUrl(message.apiUrl);
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
  if (message?.type === "getState") {
    return storageGet(["apiUrl", "activeProxy"]);
  }
  throw new Error("Unknown message type");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});
