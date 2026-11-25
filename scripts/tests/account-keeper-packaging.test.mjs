import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const json = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));

test("all Tauri platforms prepare and bundle the Account Keeper worker", async () => {
  const base = await json("src-tauri/tauri.conf.json");
  const windows = await json("src-tauri/tauri.windows.conf.json");
  for (const override of [{}, windows]) {
    const command = override.build?.beforeBuildCommand ?? base.build.beforeBuildCommand;
    const resources = { ...base.bundle.resources, ...override.bundle?.resources };
    assert.match(command, /npm run build:account-keeper-worker/);
    assert.equal(resources["resources/account-keeper/"], "account-keeper/");
  }
  assert.match(windows.build.beforeBuildCommand, /build:proxypool-sidecar/);
});

test("real native packaging stages a self-contained executable worker with verified manifest", {
  skip: process.env.ACCOUNT_KEEPER_PACKAGING_INTEGRATION !== "1",
}, async () => {
  const result = spawnSync(process.execPath, ["scripts/prepare-account-keeper-worker.mjs"], {
    cwd: root, encoding: "utf8", timeout: 240_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const resourceRoot = path.join(root, "src-tauri/resources/account-keeper");
  const manifest = await json("src-tauri/resources/account-keeper/manifest.json");
  assert.equal(manifest.node.platform, process.platform === "win32" ? "win" : process.platform);
  assert.equal(manifest.node.arch, process.arch);
  const nodeRelative = `node/${process.platform === "win32" ? "node.exe" : "node"}`;
  const paths = new Set(manifest.files.map((file) => file.path));
  for (const required of [nodeRelative, "node/LICENSE", "worker/account-keeper-worker.mjs", "worker/account-keeper-worker-runtime.mjs", "worker/adapters/registry.mjs", "worker/adapters/fixture-v1.mjs", "worker/node_modules/patchright/package.json", "worker/node_modules/patchright-core/package.json"]) {
    assert.ok(paths.has(required), required);
  }
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(resourceRoot, file.path));
    assert.equal(bytes.length, file.size, file.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  }
  const node = path.join(resourceRoot, nodeRelative);
  if (process.platform !== "win32") assert.equal((await stat(node)).mode & 0o111, 0o111);
  const version = spawnSync(node, ["--version"], { encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), manifest.node.version);
  const worker = spawnSync(node, [path.join(resourceRoot, "worker/account-keeper-worker.mjs")], {
    cwd: resourceRoot, input: "", encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: "", NODE_PATH: "", NODE_OPTIONS: "" },
  });
  assert.equal(worker.status, 0, worker.stderr);
});
