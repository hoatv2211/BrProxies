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
  if (Number(manifest.minimum_chrome_version) < 102) fail("Chrome 102+ is required for storage.session");
  for (const permission of ["proxy", "storage"]) {
    if (!manifest.permissions?.includes(permission)) fail(`missing permission: ${permission}`);
  }
  for (const host of [
    "http://127.0.0.1/*",
    "http://localhost/*",
    "https://chatgpt.com/*",
    "https://www.chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://www.chat.openai.com/*"
  ]) {
    if (!manifest.host_permissions?.includes(host)) fail(`missing host permission: ${host}`);
  }
  for (const broad of ["http://*/*", "https://*/*", "<all_urls>"]) {
    if (manifest.host_permissions?.includes(broad)) fail(`broad host permission not allowed: ${broad}`);
  }
  if (manifest.background?.service_worker !== "background.js") fail("background service worker must be background.js");
  if (manifest.background?.type !== "module") fail("background service worker must use module type");
  if (manifest.action?.default_popup !== "popup.html") fail("default popup must be popup.html");
}

for (const file of [
  "background.js",
  "codex-export.js",
  "codex-converter.js",
  "codex-session.js",
  "codex-oauth.js",
  "codex-flow.html",
  "codex-flow.css",
  "codex-flow.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "README.md"
]) {
  if (!fs.existsSync(path.join(extensionDir, file))) fail(`missing extension/${file}`);
}

const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");
if (!background.includes("chrome.storage.session")) fail("Codex API token must use session storage");
if (background.includes("storageSet({ brApiToken")) fail("Codex API token must not use persistent local storage");

const popup = fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8");
for (const required of [
  "Codex Export",
  "Connect &amp; Export",
  "JSON Convert",
  "nine_router",
  "cockpit",
  "exportButton",
  "useCurrentChatGptSession",
  "converterInput",
  "converterFileInput",
  "convertButton"
]) {
  if (!popup.includes(required)) fail(`popup missing Codex export control: ${required}`);
}

const popupScript = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
if (!popupScript.includes('from "./codex-converter.js"')) {
  fail("popup must use the local Codex JSON converter");
}

const flowScript = fs.readFileSync(path.join(extensionDir, "codex-flow.js"), "utf8");
if (!flowScript.includes('type: "connectAndExportCodex"')) {
  fail("Codex flow must request connect-and-export orchestration");
}
if (/document\.cookie|localStorage/i.test(flowScript)) {
  fail("Codex flow must not read cookies or persistent browser storage");
}

if (!background.includes("requireActiveChatGPTTab")) {
  fail("background must validate the active ChatGPT session before OAuth");
}
if (/chrome\.cookies|localStorage/i.test(background)) {
  fail("background must not read cookies or page storage for Codex export");
}
