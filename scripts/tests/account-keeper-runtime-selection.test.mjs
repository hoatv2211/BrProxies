import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as runtimes from "../account-keeper-runtime-cache.mjs";

const config = JSON.parse(await readFile(new URL("../../automation/node-runtime.json", import.meta.url)));

test("selects pinned official archives for native and Windows targets", () => {
  assert.equal(typeof runtimes.selectRuntime, "function");
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const arch of ["x64", "arm64"]) {
      const runtime = runtimes.selectRuntime(config, platform, arch);
      const nodePlatform = platform === "win32" ? "win" : platform;
      assert.equal(runtime.platform, nodePlatform);
      assert.equal(runtime.arch, arch);
      assert.equal(runtime.archive, `node-${runtime.version}-${nodePlatform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`);
      assert.equal(runtime.url, `https://nodejs.org/dist/${runtime.version}/${runtime.archive}`);
      assert.equal(runtime.shasums_url, `https://nodejs.org/dist/${runtime.version}/SHASUMS256.txt`);
      assert.match(runtime.sha256, /^[a-f0-9]{64}$/);
    }
  }
  assert.throws(() => runtimes.selectRuntime(config, "freebsd", "x64"), /Unsupported/);
  assert.throws(() => runtimes.selectRuntime(config, "linux", "ia32"), /Unsupported/);
});
