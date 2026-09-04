import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_MARKER = ".archive-sha256";

export async function prepareExtractedRuntime({
  archivePath,
  archiveName,
  extractRoot,
  sha256,
  expandArchive,
  resetDestination,
}) {
  const extractedNodeRoot = path.join(extractRoot, path.basename(archiveName, ".zip"));
  const nodeExecutable = path.join(extractedNodeRoot, "node.exe");
  const nodeLicense = path.join(extractedNodeRoot, "LICENSE");
  const markerPath = path.join(extractRoot, CACHE_MARKER);
  const expectedSha = sha256.toLowerCase();

  if (await cacheIsCurrent(markerPath, expectedSha, nodeExecutable, nodeLicense)) {
    return { nodeExecutable, nodeLicense, reused: true };
  }

  await resetDestination(extractRoot);
  await mkdir(extractRoot, { recursive: true });
  await expandArchive(archivePath, extractRoot);
  await requireFile(nodeExecutable, "Node executable");
  await requireFile(nodeLicense, "Node license");
  await writeFile(markerPath, `${expectedSha}\n`, "utf8");

  return { nodeExecutable, nodeLicense, reused: false };
}

async function cacheIsCurrent(markerPath, expectedSha, nodeExecutable, nodeLicense) {
  const marker = await readFile(markerPath, "utf8").catch(() => null);
  return marker?.trim().toLowerCase() === expectedSha
    && await isFile(nodeExecutable)
    && await isFile(nodeLicense);
}

async function requireFile(filePath, label) {
  if (!(await isFile(filePath))) {
    throw new Error(`${label} is missing`);
  }
}

async function isFile(filePath) {
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() === true;
}
