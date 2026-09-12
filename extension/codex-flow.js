import { createCodexDownload, normalizeLoopbackApiUrl } from "./codex-export.js";

const DEFAULT_BRPROXIES_API_URL = "http://127.0.0.1:40325";
const params = new URLSearchParams(window.location.search);
const profileIds = Array.from(new Set(params.getAll("profile").filter(Boolean)));
const format = params.get("format") || "nine_router";
const apiUrl = normalizeLoopbackApiUrl(params.get("apiUrl"), DEFAULT_BRPROXIES_API_URL);

const els = {
  statusMark: document.getElementById("statusMark"),
  statusLabel: document.getElementById("statusLabel"),
  statusTitle: document.getElementById("statusTitle"),
  statusDetail: document.getElementById("statusDetail"),
  profileCount: document.getElementById("profileCount"),
  formatName: document.getElementById("formatName"),
  retryButton: document.getElementById("retryButton")
};

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) return reject(new Error(error.message));
      if (!response?.ok) return reject(new Error(response?.error || "Extension request failed"));
      resolve(response.data);
    });
  });
}

function friendlyError(error) {
  const message = error?.message || String(error);
  if (/^401\b/.test(message) || /Bearer token/.test(message)) {
    return "Reconnect BrProxies from the extension popup and try again.";
  }
  if (message === "codex_oauth_timed_out") return "OAuth timed out. Start again and finish the OpenAI approval within five minutes.";
  if (message === "codex_profile_not_verified") return "This profile is not a verified Account Keeper profile.";
  if (message === "codex_oauth_in_progress") return "An OAuth request is already open for this profile. Finish it, then try again.";
  if (message === "codex_oauth_failed") return "OAuth failed. Confirm the signed-in ChatGPT account matches the selected Account Keeper profile.";
  return message;
}

function setState(kind, label, title, detail) {
  els.statusMark.className = `status-mark ${kind}`;
  els.statusLabel.textContent = label;
  els.statusTitle.textContent = title;
  els.statusDetail.textContent = detail;
}

function downloadJson(data) {
  const download = createCodexDownload(data.format, data.accounts);
  const objectUrl = URL.createObjectURL(new Blob([download.json], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = download.filename;
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

async function run() {
  els.retryButton.hidden = true;
  setState(
    "working",
    "OAuth in progress",
    "Keep this page open",
    "Approve any OpenAI tab that opens. Each selected account must match its Account Keeper profile."
  );
  try {
    const data = await sendMessage({
      type: "connectAndExportCodex",
      apiUrl,
      profileIds,
      format
    });
    downloadJson(data);
    const refreshed = data.refreshedCount ? ` ${data.refreshedCount} credential(s) were refreshed.` : "";
    setState(
      "done",
      "Download ready",
      `Exported ${data.exportedCount} account${data.exportedCount === 1 ? "" : "s"}`,
      `The ${format === "nine_router" ? "9Router" : "Cockpit"} JSON download has started.${refreshed}`
    );
  } catch (error) {
    setState("failed", "Action required", "Connect & Export failed", friendlyError(error));
    els.retryButton.hidden = false;
  }
}

els.profileCount.textContent = String(profileIds.length);
els.formatName.textContent = format === "nine_router" ? "9Router" : "Cockpit";
els.retryButton.addEventListener("click", run);
run();
