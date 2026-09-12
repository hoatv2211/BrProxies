import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(testDir, "..");

test("Codex tab renders redacted profiles returned by BrProxies", async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8"), {
    url: "chrome-extension://brproxies/popup.html"
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    chrome: globalThis.chrome
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message.type === "getState") {
          callback({ ok: true, data: { hasBrApiToken: false } });
          return;
        }
        if (message.type === "connectCodexExport") {
          callback({
            ok: true,
            data: {
              apiUrl: "http://127.0.0.1:40325",
              hasToken: true,
              profiles: [
                {
                  profile_id: "synthetic-profile-id",
                  masked_account: "o***r@example.test",
                  codex_auth: { status: "ready" }
                }
              ]
            }
          });
          return;
        }
        callback({ ok: false, error: "unexpected test message" });
      }
    }
  };

  try {
    await import(`${pathToFileURL(path.join(extensionDir, "popup.js")).href}?test=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById("brTokenInput").value = "synthetic-api-token";
    document.getElementById("codexConnectButton").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.match(document.getElementById("codexStatusText").textContent, /Connected/);
    assert.equal(document.getElementById("codexCountBadge").textContent, "1");
    assert.match(document.getElementById("profileList").textContent, /o\*\*\*r@example\.test/);
    assert.equal(document.querySelector('#profileList input[type="checkbox"]').checked, true);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.chrome = previous.chrome;
    dom.window.close();
  }
});

test("missing Codex credentials remain selectable and open the connect flow", async () => {
  const dom = new JSDOM(fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8"), {
    url: "chrome-extension://brproxies/popup.html"
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    chrome: globalThis.chrome
  };
  let openedUrl = "";
  dom.window.confirm = () => true;
  dom.window.open = (url) => {
    openedUrl = String(url);
    return {};
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      getURL: (file) => `chrome-extension://brproxies/${file}`,
      sendMessage(message, callback) {
        if (message.type === "getState") {
          callback({ ok: true, data: { hasBrApiToken: false } });
          return;
        }
        if (message.type === "connectCodexExport") {
          callback({
            ok: true,
            data: {
              apiUrl: "http://127.0.0.1:40325",
              profiles: [
                {
                  profile_id: "synthetic-missing-profile",
                  masked_account: "m***g@example.test",
                  codex_auth: { status: "missing" }
                }
              ]
            }
          });
          return;
        }
        callback({ ok: false, error: "unexpected test message" });
      }
    }
  };

  try {
    await import(`${pathToFileURL(path.join(extensionDir, "popup.js")).href}?test=${Date.now()}-missing`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById("brTokenInput").value = "synthetic-api-token";
    document.getElementById("codexConnectButton").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const checkbox = document.querySelector('#profileList input[type="checkbox"]');
    assert.equal(checkbox.disabled, false);
    assert.equal(checkbox.checked, true);
    assert.match(document.getElementById("profileList").textContent, /Connect automatically/);
    assert.equal(document.getElementById("useCurrentChatGptSession").checked, true);

    document.getElementById("exportButton").click();
    const flowUrl = new URL(openedUrl);
    assert.equal(flowUrl.pathname, "/codex-flow.html");
    assert.deepEqual(flowUrl.searchParams.getAll("profile"), ["synthetic-missing-profile"]);
    assert.equal(flowUrl.searchParams.get("format"), "nine_router");
    assert.equal(flowUrl.searchParams.get("session"), "current_chatgpt");
    assert.equal(flowUrl.searchParams.has("token"), false);
  } finally {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.chrome = previous.chrome;
    dom.window.close();
  }
});
