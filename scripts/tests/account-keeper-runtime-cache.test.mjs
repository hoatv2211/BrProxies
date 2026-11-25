import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareExtractedRuntime } from "../account-keeper-runtime-cache.mjs";

for (const platform of ["darwin", "linux"]) {
  test(`extracts ${platform} tar runtime and repairs executable permissions on reuse`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "brproxies-native-node-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const archiveName = `node-v24.18.0-${platform}-arm64.tar.gz`;
    const extractRoot = path.join(root, "extracted");
    let expansions = 0;
    const options = {
      archiveName, archivePath: path.join(root, archiveName), extractRoot,
      sha256: "b".repeat(64),
      resetDestination: (target) => rm(target, { recursive: true, force: true }),
      expandArchive: async (_source, destination) => {
        expansions++;
        const nodeRoot = path.join(destination, archiveName.replace(/\.tar\.gz$/, ""));
        await mkdir(path.join(nodeRoot, "bin"), { recursive: true });
        await writeFile(path.join(nodeRoot, "bin", "node"), "native-node", { mode: 0o644 });
        await writeFile(path.join(nodeRoot, "LICENSE"), "license");
      },
    };
    const first = await prepareExtractedRuntime(options);
    assert.equal(first.nodeExecutable, path.join(extractRoot, archiveName.replace(/\.tar\.gz$/, ""), "bin", "node"));
    if (process.platform !== "win32") assert.equal((await stat(first.nodeExecutable)).mode & 0o111, 0o111);
    await chmod(first.nodeExecutable, 0o644);
    const second = await prepareExtractedRuntime(options);
    assert.equal(second.reused, true);
    assert.equal(expansions, 1);
    if (process.platform !== "win32") assert.equal((await stat(second.nodeExecutable)).mode & 0o111, 0o111);
  });
}

test("reuses a verified extracted Node runtime", async (context) => {
  let prepareExtractedRuntime;
  try {
    ({ prepareExtractedRuntime } = await import("../account-keeper-runtime-cache.mjs"));
  } catch (error) {
    assert.fail(`runtime cache helper is unavailable: ${error.code ?? error.message}`);
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "brproxies-node-cache-"));
  context.after(() => rm(tempRoot, { recursive: true, force: true }));

  const archiveName = "node-v24.18.0-win-x64.zip";
  const archivePath = path.join(tempRoot, archiveName);
  const extractRoot = path.join(tempRoot, "v24.18.0-win-x64");
  const sha256 = "a".repeat(64);
  let expansionCount = 0;

  const expandArchive = async (_source, destination) => {
    expansionCount += 1;
    const nodeRoot = path.join(destination, path.basename(archiveName, ".zip"));
    await mkdir(nodeRoot, { recursive: true });
    await writeFile(path.join(nodeRoot, "node.exe"), "node-runtime");
    await writeFile(path.join(nodeRoot, "LICENSE"), "node-license");
  };
  const resetDestination = (destination) => rm(destination, { recursive: true, force: true });

  const first = await prepareExtractedRuntime({
    archivePath,
    archiveName,
    extractRoot,
    sha256,
    expandArchive,
    resetDestination,
  });
  const second = await prepareExtractedRuntime({
    archivePath,
    archiveName,
    extractRoot,
    sha256,
    expandArchive,
    resetDestination,
  });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(expansionCount, 1);
  assert.equal(second.nodeExecutable, first.nodeExecutable);
  assert.equal(second.nodeLicense, first.nodeLicense);
});
