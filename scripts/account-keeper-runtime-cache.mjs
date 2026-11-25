import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_MARKER = ".archive-sha256";

export function selectRuntime(config, platform = process.platform, arch = process.arch) {
  const nodePlatform = platform === "win32" ? "win" : platform;
  const sha256 = config.targets?.[`${nodePlatform}-${arch}`];
  if (!["win", "darwin", "linux"].includes(nodePlatform) || !["x64", "arm64"].includes(arch) || !sha256) {
    throw new Error(`Unsupported Account Keeper Node target: ${platform}-${arch}`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(config.version) || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("Invalid pinned Node runtime version or SHA-256");
  }
  const archive = `node-${config.version}-${nodePlatform}-${arch}.${nodePlatform === "win" ? "zip" : "tar.gz"}`;
  return {
    version: config.version, platform: nodePlatform, arch, archive, sha256,
    url: `https://nodejs.org/dist/${config.version}/${archive}`,
    shasums_url: `https://nodejs.org/dist/${config.version}/SHASUMS256.txt`,
  };
}

export async function prepareExtractedRuntime({
  archivePath,
  archiveName,
  extractRoot,
  sha256,
  expandArchive,
  resetDestination,
}) {
  const native = archiveName.endsWith(".tar.gz");
  const extractedNodeRoot = path.join(extractRoot, path.basename(archiveName, native ? ".tar.gz" : ".zip"));
  const nodeExecutable = path.join(extractedNodeRoot, ...(native ? ["bin", "node"] : ["node.exe"]));
  const nodeLicense = path.join(extractedNodeRoot, "LICENSE");
  const markerPath = path.join(extractRoot, CACHE_MARKER);
  const expectedSha = sha256.toLowerCase();

  if (await cacheIsCurrent(markerPath, expectedSha, nodeExecutable, nodeLicense)) {
    if (native) await chmod(nodeExecutable, 0o755);
    return { nodeExecutable, nodeLicense, reused: true };
  }

  await resetDestination(extractRoot);
  await mkdir(extractRoot, { recursive: true });
  await expandArchive(archivePath, extractRoot);
  await requireFile(nodeExecutable, "Node executable");
  await requireFile(nodeLicense, "Node license");
  if (native) await chmod(nodeExecutable, 0o755);
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
