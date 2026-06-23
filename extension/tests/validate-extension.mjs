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
