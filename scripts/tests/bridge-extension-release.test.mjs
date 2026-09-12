import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("Windows releases bundle BrProxies Bridge for profile auto-load", () => {
  const windowsConfig = readJson("src-tauri/tauri.windows.conf.json");
  const required = [
    "manifest.json",
    "background.js",
    "codex-converter.js",
    "codex-export.js",
    "codex-oauth.js",
    "codex-flow.html",
    "codex-flow.css",
    "codex-flow.js",
    "popup.html",
    "popup.css",
    "popup.js",
  ];
  for (const file of required) {
    assert.equal(existsSync(`extension/${file}`), true, `${file} should exist`);
    assert.equal(
      windowsConfig.bundle.resources[`../extension/${file}`],
      `bridge-extension/${file}`,
    );
  }
  assert.equal(windowsConfig.bundle.resources["../extension/"], undefined);

  const smartBuild = readFileSync("smart launch/smart-build.ps1", "utf8");
  assert.match(smartBuild, /function Sync-BridgeExtension/);
  assert.match(smartBuild, /target[\\/]release[\\/]bridge-extension/);
  assert.match(smartBuild, /"extension"/);
  assert.match(smartBuild, /unexpectedFiles/);
  assert.match(smartBuild, /Remove-Item -LiteralPath \$file\.FullName -Force/);
  assert.match(smartBuild, /Compare-Object \(\$required \| Sort-Object\)/);

  const launcher = readFileSync("src-tauri/src/launch.rs", "utf8");
  assert.match(launcher, /--load-extension=/);
  assert.match(launcher, /stored\.meta\.bridge_enabled/);
});
