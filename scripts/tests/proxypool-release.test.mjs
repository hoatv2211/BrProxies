import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

test("Windows release builds and bundles a self-contained ProxyPool", () => {
  const pkg = readJson("package.json");
  const windowsConfig = readJson("src-tauri/tauri.windows.conf.json");

  assert.equal(
    pkg.scripts["build:proxypool-sidecar"],
    "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-proxypool-sidecar.ps1",
  );
  assert.match(
    windowsConfig.build.beforeBuildCommand,
    /npm run build:proxypool-sidecar/,
  );
  assert.equal(
    windowsConfig.bundle.resources["resources/proxypool/"],
    "proxypool/",
  );
  assert.equal(existsSync("scripts/prepare-proxypool-sidecar.ps1"), true);
  if (existsSync("scripts/prepare-proxypool-sidecar.ps1")) {
    const prepare = readFileSync("scripts/prepare-proxypool-sidecar.ps1", "utf8");
    assert.match(prepare, /PyInstaller/);
    assert.match(prepare, /redis-server\.exe/);
  }

  const smartBuild = readFileSync("smart launch/smart-build.ps1", "utf8");
  assert.match(smartBuild, /Sync-ProxyPoolResources/);
  assert.match(smartBuild, /target[\\/]release[\\/]proxypool/);
});

test("release CI provisions the pinned Python used to freeze ProxyPool", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");
  assert.match(workflow, /actions\/setup-python@v5/);
  assert.match(workflow, /python-version:\s*['"]3\.11['"]/);
});
