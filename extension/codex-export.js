const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
const EXPORT_FORMATS = new Set(["nine_router", "cockpit"]);

export function normalizeLoopbackApiUrl(value, fallback) {
  const url = new URL(String(value || fallback).trim());
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("BrProxies API URL must use http://127.0.0.1 or http://localhost");
  }
  if (url.username || url.password) {
    throw new Error("API URL must not contain credentials");
  }
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export function isCodexExportable(profile) {
  return profile?.codex_auth?.status !== "missing";
}

export function createCodexDownload(format, accounts, now = new Date()) {
  if (!EXPORT_FORMATS.has(format)) {
    throw new Error("Unsupported Codex export format");
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("No Codex accounts were exported");
  }
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const target = format === "nine_router" ? "9router" : "cockpit";
  return {
    filename: `brproxies-codex-${target}-${timestamp}.json`,
    json: `${JSON.stringify(accounts, null, 2)}\n`
  };
}
