import { convertCodexJson, createConvertedDownload } from "./codex-converter.js";

const DEFAULT_POOL_API_URL = "http://127.0.0.1:40326";
const DEFAULT_BRPROXIES_API_URL = "http://127.0.0.1:40325";

const els = {
  tabs: Array.from(document.querySelectorAll(".tab")),
  codexPanel: document.getElementById("codexPanel"),
  converterPanel: document.getElementById("converterPanel"),
  proxyPanel: document.getElementById("proxyPanel"),
  brApiUrlInput: document.getElementById("brApiUrlInput"),
  brTokenInput: document.getElementById("brTokenInput"),
  codexConnectButton: document.getElementById("codexConnectButton"),
  forgetTokenButton: document.getElementById("forgetTokenButton"),
  selectAllButton: document.getElementById("selectAllButton"),
  exportButton: document.getElementById("exportButton"),
  formatSelect: document.getElementById("formatSelect"),
  codexStatusText: document.getElementById("codexStatusText"),
  codexCountBadge: document.getElementById("codexCountBadge"),
  profileList: document.getElementById("profileList"),
  conversionDirectionSelect: document.getElementById("conversionDirectionSelect"),
  converterFileInput: document.getElementById("converterFileInput"),
  converterFileName: document.getElementById("converterFileName"),
  converterInput: document.getElementById("converterInput"),
  clearConverterButton: document.getElementById("clearConverterButton"),
  convertButton: document.getElementById("convertButton"),
  converterStatusText: document.getElementById("converterStatusText"),
  apiUrlInput: document.getElementById("apiUrlInput"),
  statusText: document.getElementById("statusText"),
  countBadge: document.getElementById("countBadge"),
  connectButton: document.getElementById("connectButton"),
  testLiveButton: document.getElementById("testLiveButton"),
  rotateButton: document.getElementById("rotateButton"),
  directButton: document.getElementById("directButton"),
  activeProxy: document.getElementById("activeProxy"),
  errorText: document.getElementById("errorText"),
  successText: document.getElementById("successText"),
  proxyList: document.getElementById("proxyList")
};

const busyButtons = [
  els.codexConnectButton,
  els.forgetTokenButton,
  els.selectAllButton,
  els.exportButton,
  els.clearConverterButton,
  els.convertButton,
  els.connectButton,
  els.testLiveButton,
  els.rotateButton,
  els.directButton
];

let proxies = [];
let totalProxies = 0;
let managedProfiles = [];

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
  for (const button of busyButtons) button.disabled = isBusy;
  if (!isBusy) {
    const hasManagedProfile = managedProfiles.length > 0;
    els.exportButton.disabled = !hasManagedProfile;
    els.selectAllButton.disabled = !hasManagedProfile;
  }
}

function clearMessages() {
  els.errorText.hidden = true;
  els.errorText.textContent = "";
  els.successText.hidden = true;
  els.successText.textContent = "";
}

function friendlyError(error) {
  const message = error?.message || String(error);
  if (/^401\b/.test(message)) return "Bearer token is missing or invalid. Copy it again from BrProxies Settings.";
  if (message === "codex_reconnect_required") return "A selected Codex account needs to be reconnected in BrProxies.";
  return message;
}

function setError(error) {
  clearMessages();
  els.errorText.hidden = false;
  els.errorText.textContent = friendlyError(error);
}

function setSuccess(message) {
  clearMessages();
  els.successText.hidden = false;
  els.successText.textContent = message;
}

function switchTab(tabName) {
  const panels = {
    codex: els.codexPanel,
    converter: els.converterPanel,
    proxy: els.proxyPanel
  };
  for (const [name, panel] of Object.entries(panels)) {
    const active = name === tabName;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  }
  for (const tab of els.tabs) tab.classList.toggle("active", tab.dataset.tab === tabName);
  clearMessages();
}

function selectedProfileIds() {
  return Array.from(els.profileList.querySelectorAll('input[type="checkbox"]:checked')).map(
    (input) => input.value
  );
}

function codexStatusLabel(profile) {
  if (profile.codex_auth?.status === "ready") return "Ready";
  if (profile.codex_auth?.status === "reconnect_required") return "Reconnect automatically";
  return "Connect automatically";
}

function renderProfiles() {
  els.profileList.textContent = "";
  els.codexCountBadge.textContent = String(managedProfiles.length);
  els.exportButton.disabled = managedProfiles.length === 0;

  if (managedProfiles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No verified Account Keeper profiles found.";
    els.profileList.append(empty);
    return;
  }

  for (const profile of managedProfiles) {
    const row = document.createElement("label");
    row.className = "profile-row";
    row.role = "listitem";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = profile.profile_id;
    checkbox.checked = profile.codex_auth?.status === "ready" || managedProfiles.length === 1;

    const identity = document.createElement("span");
    identity.className = "profile-identity";
    const account = document.createElement("strong");
    account.textContent = profile.masked_account;
    const profileId = document.createElement("small");
    profileId.textContent = profile.profile_id;
    identity.append(account, profileId);

    const status = document.createElement("span");
    status.className = `status-chip ${profile.codex_auth?.status || "missing"}`;
    status.textContent = codexStatusLabel(profile);

    row.append(checkbox, identity, status);
    els.profileList.append(row);
  }
}

async function connectCodexExport() {
  setBusy(true);
  clearMessages();
  els.codexStatusText.textContent = "Connecting to BrProxies...";
  try {
    const data = await sendMessage({
      type: "connectCodexExport",
      apiUrl: els.brApiUrlInput.value.trim() || DEFAULT_BRPROXIES_API_URL,
      token: els.brTokenInput.value.trim()
    });
    els.brApiUrlInput.value = data.apiUrl;
    els.brTokenInput.value = "";
    els.brTokenInput.placeholder = "Token stored for this Chrome session";
    managedProfiles = Array.isArray(data.profiles) ? data.profiles : [];
    renderProfiles();
    els.codexStatusText.textContent = `Connected - ${managedProfiles.length} verified profile${managedProfiles.length === 1 ? "" : "s"}`;
  } catch (error) {
    managedProfiles = [];
    renderProfiles();
    els.codexStatusText.textContent = "Not connected";
    setError(error);
  } finally {
    setBusy(false);
  }
}

async function forgetCodexToken() {
  setBusy(true);
  try {
    await sendMessage({ type: "forgetCodexToken" });
    els.brTokenInput.value = "";
    els.brTokenInput.placeholder = "Paste from BrProxies Settings";
    managedProfiles = [];
    renderProfiles();
    els.codexStatusText.textContent = "Session token forgotten";
    setSuccess("Automation API token removed from extension session storage.");
  } catch (error) {
    setError(error);
  } finally {
    setBusy(false);
  }
}

function selectAllProfiles() {
  const checkboxes = Array.from(
    els.profileList.querySelectorAll('input[type="checkbox"]:not(:disabled)')
  );
  const shouldSelect = checkboxes.some((checkbox) => !checkbox.checked);
  for (const checkbox of checkboxes) checkbox.checked = shouldSelect;
  els.selectAllButton.textContent = shouldSelect ? "Clear all" : "Select all";
}

function exportCodexJson() {
  const profileIds = selectedProfileIds();
  if (profileIds.length === 0) {
    setError(new Error("Select at least one Codex profile"));
    return;
  }
  if (!window.confirm(
    "BrProxies may open an OpenAI OAuth tab for profiles that need connection. The downloaded JSON contains plaintext OAuth tokens. Continue?"
  )) return;

  const flowUrl = new URL(chrome.runtime.getURL("codex-flow.html"));
  for (const profileId of profileIds) flowUrl.searchParams.append("profile", profileId);
  flowUrl.searchParams.set("format", els.formatSelect.value);
  flowUrl.searchParams.set(
    "apiUrl",
    els.brApiUrlInput.value.trim() || DEFAULT_BRPROXIES_API_URL
  );
  window.open(flowUrl.toString(), "_blank", "noopener");
}

function clearConverterInput() {
  els.converterInput.value = "";
  els.converterFileInput.value = "";
  els.converterFileName.textContent = "or paste JSON below";
  els.converterStatusText.textContent = "Waiting for JSON";
  clearMessages();
}

async function loadConverterFile() {
  const [file] = els.converterFileInput.files || [];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    els.converterFileInput.value = "";
    setError(new Error("JSON file must be 5 MB or smaller"));
    return;
  }

  clearMessages();
  try {
    els.converterInput.value = await file.text();
    els.converterFileName.textContent = file.name;
    els.converterStatusText.textContent = "JSON loaded locally";
  } catch (error) {
    setError(error);
  }
}

async function convertAccountJson() {
  const input = els.converterInput.value.trim();
  if (!input) {
    setError(new Error("Choose a JSON file or paste JSON to convert"));
    return;
  }
  if (!window.confirm("The converted file contains plaintext Codex OAuth tokens. Continue?")) return;

  setBusy(true);
  clearMessages();
  let objectUrl = "";
  try {
    const result = convertCodexJson(input, els.conversionDirectionSelect.value);
    const download = createConvertedDownload(result);
    objectUrl = URL.createObjectURL(new Blob([download.json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = download.filename;
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    objectUrl = "";

    els.converterInput.value = "";
    els.converterFileInput.value = "";
    els.converterFileName.textContent = "or paste JSON below";
    const source = result.sourceFormat === "nine_router" ? "9Router" : "Cockpit";
    const target = result.targetFormat === "nine_router" ? "9Router" : "Cockpit";
    els.converterStatusText.textContent = `${source} to ${target} - ${result.accounts.length} account${result.accounts.length === 1 ? "" : "s"}`;
    setSuccess("Converted JSON downloaded. Source data was cleared from the popup.");
  } catch (error) {
    setError(error);
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setBusy(false);
  }
}

function proxyLabel(proxy) {
  return String(proxy?.proxy || "").trim();
}

function liveProxyList(items) {
  return (Array.isArray(items) ? items : []).filter(
    (proxy) => proxyLabel(proxy) && Number(proxy?.fail_count || 0) === 0
  );
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

function renderProxyList() {
  els.proxyList.textContent = "";
  const valid = liveProxyList(proxies);
  els.countBadge.textContent = String(valid.length);
  if (valid.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No live proxies available.";
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
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = proxyMeta(proxy);
    main.append(title, meta);
    const button = document.createElement("button");
    button.className = "use-button";
    button.type = "button";
    button.textContent = "Use";
    button.addEventListener("click", () => useProxy(proxy));
    row.append(main, button);
    els.proxyList.append(row);
  }
}

async function connectProxyPool() {
  setBusy(true);
  clearMessages();
  try {
    const data = await sendMessage({
      type: "connect",
      apiUrl: els.apiUrlInput.value.trim() || DEFAULT_POOL_API_URL
    });
    els.apiUrlInput.value = data.apiUrl;
    proxies = liveProxyList(data.proxies);
    setPoolStatus(data, "Connected");
    renderProxyList();
  } catch (error) {
    els.statusText.textContent = "Disconnected";
    setError(error);
  } finally {
    setBusy(false);
  }
}

async function testLive() {
  setBusy(true);
  clearMessages();
  els.statusText.textContent = "Testing live proxies...";
  try {
    const data = await sendMessage({
      type: "testLive",
      apiUrl: els.apiUrlInput.value.trim() || DEFAULT_POOL_API_URL
    });
    els.apiUrlInput.value = data.apiUrl;
    proxies = liveProxyList(data.proxies);
    setPoolStatus(data, "Tested");
    renderProxyList();
  } catch (error) {
    setError(error);
  } finally {
    setBusy(false);
  }
}

async function useProxy(proxy) {
  setBusy(true);
  clearMessages();
  try {
    const data = await sendMessage({ type: "setProxy", proxy });
    els.activeProxy.textContent = data.activeProxy || "Direct";
  } catch (error) {
    setError(error);
  } finally {
    setBusy(false);
  }
}

async function rotateProxy() {
  setBusy(true);
  clearMessages();
  try {
    const data = await sendMessage({
      type: "rotateProxy",
      apiUrl: els.apiUrlInput.value.trim() || DEFAULT_POOL_API_URL
    });
    els.activeProxy.textContent = data.activeProxy || "Direct";
    await connectProxyPool();
  } catch (error) {
    setError(error);
  } finally {
    setBusy(false);
  }
}

async function clearProxy() {
  setBusy(true);
  clearMessages();
  try {
    await sendMessage({ type: "clearProxy" });
    els.activeProxy.textContent = "Direct";
  } catch (error) {
    setError(error);
  } finally {
    setBusy(false);
  }
}

async function restoreState() {
  renderProfiles();
  renderProxyList();
  if (!globalThis.chrome?.runtime?.sendMessage) return;
  try {
    const state = await sendMessage({ type: "getState" });
    els.apiUrlInput.value = state.apiUrl || DEFAULT_POOL_API_URL;
    els.brApiUrlInput.value = state.brApiUrl || DEFAULT_BRPROXIES_API_URL;
    els.activeProxy.textContent = state.activeProxy || "Direct";
    if (state.hasBrApiToken) {
      els.brTokenInput.placeholder = "Token stored for this Chrome session";
      await connectCodexExport();
    }
  } catch (error) {
    setError(error);
  }
}

for (const tab of els.tabs) tab.addEventListener("click", () => switchTab(tab.dataset.tab));
els.codexConnectButton.addEventListener("click", connectCodexExport);
els.forgetTokenButton.addEventListener("click", forgetCodexToken);
els.selectAllButton.addEventListener("click", selectAllProfiles);
els.exportButton.addEventListener("click", exportCodexJson);
els.converterFileInput.addEventListener("change", loadConverterFile);
els.clearConverterButton.addEventListener("click", clearConverterInput);
els.convertButton.addEventListener("click", convertAccountJson);
els.connectButton.addEventListener("click", connectProxyPool);
els.testLiveButton.addEventListener("click", testLive);
els.rotateButton.addEventListener("click", rotateProxy);
els.directButton.addEventListener("click", clearProxy);

restoreState();
