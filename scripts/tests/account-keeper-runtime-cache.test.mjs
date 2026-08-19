import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
