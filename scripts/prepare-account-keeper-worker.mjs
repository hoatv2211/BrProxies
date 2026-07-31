import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const automationDir = path.join(repoRoot, "automation");
const runtimePath = path.join(automationDir, "node-runtime.json");
const cacheRoot = path.join(repoRoot, ".brproxies-build-cache", "account-keeper");
const resourceRoot = path.join(repoRoot, "src-tauri", "resources", "account-keeper");

assertInsideRepo(cacheRoot);
assertInsideRepo(resourceRoot);

const runtime = JSON.parse(await readFile(runtimePath, "utf8"));
validateRuntime(runtime);

runNpmCi();
await mkdir(cacheRoot, { recursive: true });

const shasums = await downloadText(runtime.shasums_url);
const publishedSha = shaForArchive(shasums, runtime.archive);
if (publishedSha !== runtime.sha256) {
  throw new Error("Node runtime SHA does not match official SHASUMS256.txt");
}

const archivePath = path.join(cacheRoot, runtime.archive);
if (!(await fileHasSha(archivePath, runtime.sha256))) {
  const response = await fetch(runtime.url);
  if (!response.ok) {
    throw new Error(`Node runtime download failed with HTTP ${response.status}`);
  }
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
}
if (!(await fileHasSha(archivePath, runtime.sha256))) {
  throw new Error("Downloaded Node runtime failed SHA-256 verification");
}

const extractRoot = path.join(cacheRoot, `${runtime.version}-${runtime.platform}-${runtime.arch}`);
await safeRemove(extractRoot);
await mkdir(extractRoot, { recursive: true });
expandZip(archivePath, extractRoot);

const extractedNodeRoot = path.join(extractRoot, path.basename(runtime.archive, ".zip"));
const nodeExecutable = path.join(extractedNodeRoot, "node.exe");
const nodeLicense = path.join(extractedNodeRoot, "LICENSE");
await requireFile(nodeExecutable, "Node executable");
await requireFile(nodeLicense, "Node license");

await safeRemove(resourceRoot);
const bundledNodeDir = path.join(resourceRoot, "node");
const bundledWorkerDir = path.join(resourceRoot, "worker");
await mkdir(bundledNodeDir, { recursive: true });
await mkdir(bundledWorkerDir, { recursive: true });

await cp(nodeExecutable, path.join(bundledNodeDir, "node.exe"));
await cp(nodeLicense, path.join(bundledNodeDir, "LICENSE"));
const workerModules = await collectModuleGraph(
  path.join(automationDir, "account-keeper-worker.mjs"),
);
for (const source of workerModules) {
  const relative = path.relative(automationDir, source);
  const destination = path.join(bundledWorkerDir, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}
for (const metadata of ["package.json", "package-lock.json"]) {
  const source = path.join(automationDir, metadata);
  await requireFile(source, metadata);
  await cp(source, path.join(bundledWorkerDir, metadata));
}

const bundledModules = path.join(bundledWorkerDir, "node_modules");
await mkdir(bundledModules, { recursive: true });
for (const dependency of ["patchright", "patchright-core"]) {
  const source = path.join(automationDir, "node_modules", dependency);
  await requireFile(path.join(source, "package.json"), dependency);
  await cp(source, path.join(bundledModules, dependency), { recursive: true });
}

const manifest = {
  schema_version: 1,
  node: {
    version: runtime.version,
    archive: runtime.archive,
    sha256: runtime.sha256,
  },
  patchright: "1.60.1",
  files: await hashTree(resourceRoot),
};
await writeFile(
  path.join(resourceRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
await verifyManifest(resourceRoot, manifest.files);

console.log(`Prepared Account Keeper resources at ${resourceRoot}`);

function runNpmCi() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["ci", "--omit=dev", "--ignore-scripts"], {
    cwd: automationDir,
    env: {
      ...process.env,
      PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error("Unable to start npm ci for the Account Keeper worker");
  }
  if (result.status !== 0) {
    throw new Error("npm ci failed for the Account Keeper worker");
  }
}

function expandZip(archivePath, destination) {
  if (process.platform !== "win32") {
    throw new Error("Account Keeper worker packaging is supported on Windows only");
  }
  const escapedArchive = archivePath.replaceAll("'", "''");
  const escapedDestination = destination.replaceAll("'", "''");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
    ],
    { stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error("Node runtime extraction failed");
  }
}

async function downloadText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}`);
  }
  return response.text();
}

function shaForArchive(shasums, archive) {
  const line = shasums
    .split(/\r?\n/)
    .find((candidate) => candidate.endsWith(`  ${archive}`));
  if (!line) {
    throw new Error("Node archive is missing from SHASUMS256.txt");
  }
  return line.slice(0, 64).toLowerCase();
}

async function fileHasSha(filePath, expected) {
  if (!(await exists(filePath))) {
    return false;
  }
  const bytes = await readFile(filePath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  return actual === expected.toLowerCase();
}

async function hashTree(root) {
  const files = [];
  await walk(root, root, files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function walk(root, current, files) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files);
      continue;
    }
    const bytes = await readFile(fullPath);
    files.push({
      path: path.relative(root, fullPath).replaceAll(path.sep, "/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
  }
}

async function collectModuleGraph(entry) {
  const pending = [entry];
  const collected = new Set();
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (collected.has(modulePath)) {
      continue;
    }
    assertInside(automationDir, modulePath);
    await requireFile(modulePath, path.relative(automationDir, modulePath));
    collected.add(modulePath);
    const source = await readFile(modulePath, "utf8");
    const imports = [
      ...source.matchAll(/\b(?:import|export)\s+(?:[^'\"]*?\s+from\s+)?["'](\.[^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g),
    ];
    for (const match of imports) {
      pending.push(path.resolve(path.dirname(modulePath), match[1]));
    }
  }
  return [...collected].sort();
}

async function verifyManifest(root, files) {
  for (const file of files) {
    const target = path.resolve(root, file.path);
    assertInside(root, target);
    if (!(await fileHasSha(target, file.sha256))) {
      throw new Error(`Staged resource failed manifest verification: ${file.path}`);
    }
  }
}

async function requireFile(filePath, label) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`${label} is missing`);
  }
}

async function exists(filePath) {
  return stat(filePath)
    .then(() => true)
    .catch(() => false);
}

async function safeRemove(target) {
  assertInsideRepo(target);
  await rm(target, { recursive: true, force: true });
}

function assertInsideRepo(target) {
  assertInside(repoRoot, target);
}

function assertInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to access a path outside the allowed root");
  }
}

function validateRuntime(value) {
  for (const field of ["version", "platform", "arch", "archive", "url", "shasums_url", "sha256"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`Invalid Node runtime field: ${field}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error("Invalid Node runtime SHA-256");
  }
}
