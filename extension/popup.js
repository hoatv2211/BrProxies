const DEFAULT_API_URL = "http://127.0.0.1:40326";

const els = {
  apiUrlInput: document.getElementById("apiUrlInput"),
  statusText: document.getElementById("statusText"),
  countBadge: document.getElementById("countBadge"),
  connectButton: document.getElementById("connectButton"),
  testLiveButton: document.getElementById("testLiveButton"),
  rotateButton: document.getElementById("rotateButton"),
  directButton: document.getElementById("directButton"),
  activeProxy: document.getElementById("activeProxy"),
  errorText: document.getElementById("errorText"),
  proxyList: document.getElementById("proxyList")
};

let proxies = [];
let totalProxies = 0;

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Extension request failed"));
        return;
      }
      resolve(response.data);
    });
  });
}

function setBusy(isBusy) {
  els.connectButton.disabled = isBusy;
  els.testLiveButton.disabled = isBusy;
  els.rotateButton.disabled = isBusy;
  els.directButton.disabled = isBusy;
}

function setError(message) {
  if (!message) {
    els.errorText.hidden = true;
    els.errorText.textContent = "";
    return;
  }
  els.errorText.hidden = false;
  els.errorText.textContent = message;
}

function proxyLabel(proxy) {
  return String(proxy?.proxy || "").trim();
}

function liveProxyList(items) {
  return (Array.isArray(items) ? items : []).filter((proxy) => proxyLabel(proxy) && Number(proxy?.fail_count || 0) === 0);
}

function proxyMeta(proxy) {
  const parts = [];
  if (proxy.country) parts.push(proxy.country);
  if (proxy.source) parts.push(proxy.source);
  if (Number.isFinite(proxy.latency_ms)) parts.push(`${proxy.latency_ms} ms`);
  if (proxy.supports_https) parts.push("HTTPS OK");
  if (Number(proxy.fail_count || 0) > 0) parts.push(`${proxy.fail_count} fails`);
  return parts.join(" - ") || "working";
}

function setPoolStatus(data, prefix) {
  totalProxies = Number(data.total || data.health?.count || data.proxies?.length || 0);
  const liveCount = proxies.length;
  els.countBadge.textContent = String(liveCount);
  if (!data.health?.ok) {
    els.statusText.textContent = "Redis error";
    return;
  }
  const timeoutText = data.timedOut ? " timeout" : "";
  els.statusText.textContent = `${prefix}${timeoutText} - ${liveCount}/${totalProxies} live`;
}

function renderList() {
  els.proxyList.textContent = "";
  const valid = liveProxyList(proxies);
  els.countBadge.textContent = String(valid.length);
  if (valid.length === 0) {
    const empty = document.createElement("p");
    empty.className = "meta";
    empty.textContent = "No live proxies available";
    els.proxyList.append(empty);
    return;
  }

  for (const proxy of valid.slice(0, 80)) {
    const row = document.createElement("article");
    row.className = "proxy-row";
    row.role = "listitem";

    const main = document.createElement("div");
    main.className = "proxy-main";

    const title = document.createElement("strong");
    title.textContent = proxyLabel(proxy);
    main.append(title);

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = proxyMeta(proxy);
    main.append(meta);

    const button = document.createElement("button");
    button.className = "use-button";
    button.type = "button";
    button.textContent = "Use";
    button.addEventListener("click", () => useProxy(proxy));

    row.append(main, button);
    els.proxyList.append(row);
  }
}

async function connect() {
  setBusy(true);
  setError("");
  try {
    const data = await sendMessage({ type: "connect", apiUrl: els.apiUrlInput.value.trim() || DEFAULT_API_URL });
    els.apiUrlInput.value = data.apiUrl;
    proxies = liveProxyList(data.proxies);
    setPoolStatus(data, "Connected");
    renderList();
  } catch (error) {
    els.statusText.textContent = "Disconnected";
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function testLive() {
  setBusy(true);
  setError("");
  els.statusText.textContent = "Testing live proxies...";
  try {
    const data = await sendMessage({ type: "testLive", apiUrl: els.apiUrlInput.value.trim() || DEFAULT_API_URL });
    els.apiUrlInput.value = data.apiUrl;
    proxies = liveProxyList(data.proxies);
    setPoolStatus(data, "Tested");
    renderList();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function useProxy(proxy) {
  setBusy(true);
  setError("");
  try {
    const data = await sendMessage({ type: "setProxy", proxy });
    els.activeProxy.textContent = data.activeProxy || "Direct";
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function rotateProxy() {
  setBusy(true);
  setError("");
  try {
    const data = await sendMessage({ type: "rotateProxy", apiUrl: els.apiUrlInput.value.trim() || DEFAULT_API_URL });
    els.activeProxy.textContent = data.activeProxy || "Direct";
    await connect();
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function clearProxy() {
  setBusy(true);
  setError("");
  try {
    await sendMessage({ type: "clearProxy" });
    els.activeProxy.textContent = "Direct";
  } catch (error) {
    setError(error.message || String(error));
  } finally {
    setBusy(false);
  }
}

async function restoreState() {
  try {
    const state = await sendMessage({ type: "getState" });
    els.apiUrlInput.value = state.apiUrl || DEFAULT_API_URL;
    els.activeProxy.textContent = state.activeProxy || "Direct";
  } catch (error) {
    setError(error.message || String(error));
  }
  renderList();
}

els.connectButton.addEventListener("click", connect);
els.testLiveButton.addEventListener("click", testLive);
els.rotateButton.addEventListener("click", rotateProxy);
els.directButton.addEventListener("click", clearProxy);

restoreState();
