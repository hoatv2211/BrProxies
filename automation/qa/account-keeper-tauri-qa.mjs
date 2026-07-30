import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "patchright";

import { startAccountKeeperFixture } from "../fixtures/account-keeper-fixture-server.mjs";

const automationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(automationDir, "..");
const qaRoot = path.join(tmpdir(), "BrProxies-AccountKeeper-QA");
const configRoot = path.join(qaRoot, "config");
const filesRoot = path.join(qaRoot, "files");
const cdpUrl = "http://127.0.0.1:9229";
const appUrl = "http://127.0.0.1:1420/?account-keeper-qa=1";
const syntheticAccount = "owner@example.test";
const initialPassword = "Synthetic-Current-123!";
const totpSecret = "JBSWY3DPEHPK3PXP";
const template = "QA-{random:16}!";
const failureScreenshotPath = path.join(tmpdir(), "BrProxies-AccountKeeper-QA-failure.png");

const fixture = await startAccountKeeperFixture({
  accounts: [{
    account: syntheticAccount,
    password: initialPassword,
    totpSecret,
    manualChallenge: true,
  }],
});

let tauri = null;
let browser = null;
let page = null;
const allLogs = [];
const generatedPasswords = [];
const realProfileNamesBefore = await listRealProfileNames();

try {
  await prepareQaRoot();
  const firstInputText = inputRecord(initialPassword);
  const firstOutput = path.join(filesRoot, "result-1.json");

  ({ tauri, browser } = await startAndConnect());
  page = await openAccountKeeper(browser);
  await configureBatch(page, { kind: "inline", text: firstInputText }, firstOutput);
  await startBatch(page);
  await waitFor(
    () => page.getByLabel("Account input", { exact: true }).inputValue().then((value) => value === ""),
    30_000,
    "Pasted input stayed in React state after start",
  );
  await page.locator(".account-keeper__manual").waitFor({ state: "visible", timeout: 120_000 });
  await fixture.completeManualChallenge(syntheticAccount);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const firstResult = await waitForOutput(firstOutput);
  assertSuccessfulResult(firstResult);

  const firstAccount = firstResult.accounts[0];
  generatedPasswords.push(firstAccount.password);
  const secondInput = path.join(filesRoot, "batch-2.txt");
  const secondOutput = path.join(filesRoot, "result-2.json");
  await writeInput(secondInput, firstAccount.password);
  await configureBatch(page, { kind: "file", path: secondInput }, secondOutput);
  await startBatch(page);
  const secondResult = await waitForOutput(secondOutput);
  assertSuccessfulResult(secondResult);
  generatedPasswords.push(secondResult.accounts[0].password);
  assert.equal(secondResult.accounts[0].profile_id, firstAccount.profile_id);

  await fixture.armManualChallenge(syntheticAccount);
  const thirdInput = path.join(filesRoot, "batch-3.txt");
  const thirdOutput = path.join(filesRoot, "result-3.json");
  await writeInput(thirdInput, secondResult.accounts[0].password);
  await configureBatch(page, { kind: "file", path: thirdInput }, thirdOutput);
  await startBatch(page);
  await page.locator(".account-keeper__manual").waitFor({ state: "visible", timeout: 120_000 });
  await assertManualState(page, firstAccount.profile_id);
  const manualStateBeforeRestart = (await fixture.inspect()).accounts[syntheticAccount];

  await stopTauri(tauri);
  tauri = null;
  browser = null;

  ({ tauri, browser } = await startAndConnect());
  page = await openAccountKeeper(browser);
  await assertManualState(page, firstAccount.profile_id);
  const manualStateAfterRestart = (await fixture.inspect()).accounts[syntheticAccount];
  assert.deepEqual(manualStateAfterRestart, manualStateBeforeRestart);
  const resume = page.getByRole("button", { name: "Resume Job", exact: true });
  await resume.waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await resume.isDisabled(), true);

  const profileFiles = await readdir(path.join(configRoot, "profiles"));
  assert.equal(profileFiles.filter((name) => name.endsWith(".json")).length, 1);
  assert.deepEqual(await listRealProfileNames(), realProfileNamesBefore);
  await stopTauri(tauri);
  tauri = null;
  browser = null;
  assertLogsAreRedacted(allLogs);

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    batches: [firstResult.batch_id, secondResult.batch_id],
    profile_id: firstAccount.profile_id,
    manual_preserved: true,
    profile_reuse: true,
  })}\n`);
} catch (error) {
  const diagnostics = await collectFailureDiagnostics(page);
  assertRedactedPayload(diagnostics, "QA diagnostics");
  if (tauri) {
    await stopTauri(tauri);
    tauri = null;
  }
  assertLogsAreRedacted(allLogs);
  process.stderr.write(`Account Keeper QA diagnostics: ${JSON.stringify(diagnostics)}\n`);
  throw error;
} finally {
  if (tauri) await stopTauri(tauri).catch(() => {});
  await fixture.close().catch(() => {});
  await cleanupQaRoot().catch(() => {});
  await rm(failureScreenshotPath, { force: true }).catch(() => {});
}

async function collectFailureDiagnostics(activePage) {
  if (!activePage) return { page: "unavailable" };
  const accountInput = activePage.getByLabel("Account input", { exact: true });
  const screenshotMasks = await accountInput.count() ? [accountInput] : [];
  await activePage.screenshot({
    path: failureScreenshotPath,
    fullPage: true,
    mask: screenshotMasks,
    maskColor: "#000000",
  }).catch(() => {});
  const state = await activePage.evaluate(() => {
    const root = document.querySelector(".account-keeper");
    return {
      href: window.location.href,
      search: window.location.search,
      qaStatus: document.documentElement.dataset.accountKeeperQaStatus ?? null,
      text: root?.textContent?.replace(/\s+/g, " ").trim().slice(0, 2000) ?? null,
    };
  }).catch(() => ({ qaStatus: null, text: null }));
  return { ...state, screenshotPath: failureScreenshotPath };
}

async function prepareQaRoot() {
  assertSafeQaRoot();
  await rm(qaRoot, { recursive: true, force: true });
  await mkdir(configRoot, { recursive: true });
  await mkdir(filesRoot, { recursive: true });
  const appData = process.env.APPDATA;
  if (!appData) throw new Error("APPDATA is unavailable");
  const realFingerprints = path.join(appData, "brproxies-launcher", "fingerprints");
  if (!(await stat(realFingerprints)).isDirectory()) {
    throw new Error("BrProxies fingerprint library is unavailable");
  }
  await symlink(realFingerprints, path.join(configRoot, "fingerprints"), "junction");
}

async function cleanupQaRoot() {
  assertSafeQaRoot();
  await rm(path.join(configRoot, "fingerprints"), { force: true });
  await rm(qaRoot, { recursive: true, force: true });
}

function assertSafeQaRoot() {
  const resolved = path.resolve(qaRoot);
  const temp = path.resolve(tmpdir());
  if (!resolved.startsWith(`${temp}${path.sep}`) || path.basename(resolved) !== "BrProxies-AccountKeeper-QA") {
    throw new Error("unsafe Account Keeper QA root");
  }
}

async function startAndConnect() {
  const child = spawn("npm.cmd", ["run", "tauri", "dev"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BRPROXIES_QA_CONFIG_ROOT: configRoot,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9229",
      ACCOUNT_KEEPER_FIXTURE_ORIGIN: fixture.origin,
    },
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => logs.push(chunk));
  child.stderr.on("data", (chunk) => logs.push(chunk));
  child.once("error", (error) => logs.push(String(error)));
  await waitForCdp(child, logs);
  const connected = await chromium.connectOverCDP(cdpUrl);
  return { tauri: { child, logs }, browser: connected };
}

async function stopTauri(instance) {
  if (!instance?.child?.pid) return;
  const closed = instance.child.exitCode === null
    ? new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Tauri process did not close")), 30_000);
      instance.child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    })
    : Promise.resolve();
  spawnSync("taskkill.exe", ["/PID", String(instance.child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await closed;
  await waitFor(async () => !(await endpointAvailable(cdpUrl)), 30_000, "Tauri CDP did not stop");
  allLogs.push(...instance.logs);
}

async function waitForCdp(child, logs) {
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Tauri exited with code ${child.exitCode}: ${logs.join("").slice(-4000)}`);
    }
    return endpointAvailable(cdpUrl);
  }, 180_000, "Tauri CDP endpoint was not ready");
}

async function endpointAvailable(url) {
  return fetch(`${url}/json`)
    .then((response) => response.ok)
    .catch(() => false);
}

async function openAccountKeeper(connectedBrowser) {
  const contexts = connectedBrowser.contexts();
  assert.equal(contexts.length, 1);
  const pages = contexts[0].pages();
  assert.equal(pages.length, 1);
  const page = pages[0];
  await waitFor(async () => {
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const nav = page.getByRole("button", { name: "Account Keeper", exact: true });
    await nav.waitFor({ state: "visible", timeout: 5_000 });
    await nav.click();
    const heading = page.getByRole("heading", { name: "Account Keeper", exact: true });
    await heading.waitFor({ state: "visible", timeout: 5_000 });
    await page.waitForFunction(
      () => window.location.search.includes("account-keeper-qa=1")
        && document.documentElement.dataset.accountKeeperQaStatus === "idle",
      undefined,
      { timeout: 5_000 },
    );
    await page.waitForTimeout(300);
    return heading.isVisible().then(async (visible) => visible && page.evaluate(() => (
      window.location.search.includes("account-keeper-qa=1")
        && document.documentElement.dataset.accountKeeperQaStatus === "idle"
    )));
  }, 60_000, "Account Keeper QA bridge did not stabilize");
  return page;
}

async function configureBatch(page, source, outputPath) {
  await page.waitForFunction(
    () => document.documentElement.dataset.accountKeeperQaStatus === "idle",
  );
  await page.evaluate(({ inputSource, outputPath: output, templateText }) => {
    document.documentElement.dataset.accountKeeperQaConfig = JSON.stringify({
      source: inputSource,
      outputPath: output,
      templateText,
      adapterId: "fixture-v1",
    });
    delete document.documentElement.dataset.accountKeeperQaStatus;
    document.documentElement.dispatchEvent(new Event("account-keeper:qa-configure"));
  }, { inputSource: source, outputPath, templateText: template });
  await page.waitForFunction(() => {
    const status = document.documentElement.dataset.accountKeeperQaStatus;
    return status === "ready" || status?.startsWith("error:");
  });
  const qaStatus = await page.evaluate(
    () => document.documentElement.dataset.accountKeeperQaStatus ?? "error:missing_status",
  );
  if (qaStatus !== "ready") throw new Error(`Account Keeper QA bridge failed: ${qaStatus}`);
  await page.evaluate(() => {
    document.documentElement.dataset.accountKeeperQaStatus = "idle";
  });
  const acknowledgement = source.kind === "inline"
    ? "I understand pasted input and the output file contain plaintext secrets"
    : "I understand the selected input and output files contain plaintext secrets";
  await page.getByLabel(acknowledgement, { exact: true }).check();
  await page.getByRole("button", { name: "Start Batch", exact: true }).waitFor({ state: "visible" });
}

async function startBatch(page) {
  const start = page.getByRole("button", { name: "Start Batch", exact: true });
  await waitFor(() => start.isEnabled(), 30_000, "Start Batch stayed disabled");
  await start.click();
  const confirm = page.locator(".dialog-confirm").getByRole("button", { name: "Start Batch", exact: true });
  await confirm.waitFor({ state: "visible" });
  await confirm.click();
}

async function writeInput(filePath, password) {
  await writeFile(filePath, inputRecord(password), "utf8");
}

function inputRecord(password) {
  return `${syntheticAccount}|${password}|${totpSecret}\n`;
}

async function waitForOutput(filePath) {
  await waitFor(async () => {
    const text = await readFile(filePath, "utf8").catch(() => "");
    if (!text) return false;
    const value = JSON.parse(text);
    const status = value.accounts?.[0]?.status;
    if (["failed", "critical", "cancelled"].includes(status)) {
      const error = new Error(`Account Keeper ended with ${status}`);
      error.fatal = true;
      throw error;
    }
    return value.accounts?.[0]?.status === "success" && value.accounts?.[0]?.password_state === "changed";
  }, 180_000, `Account Keeper output was not completed: ${filePath}`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertSuccessfulResult(result) {
  assert.equal(result.schema_version, 1);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].account, syntheticAccount);
  assert.equal(result.accounts[0].status, "success");
  assert.equal(result.accounts[0].password_state, "changed");
  assert.equal(typeof result.accounts[0].profile_id, "string");
  assert.ok(result.accounts[0].profile_id.length > 0);
}

async function assertManualState(activePage, profileId) {
  const stage = activePage.locator(".account-keeper__stage.is-waiting_manual");
  await stage.waitFor({ state: "visible", timeout: 30_000 });
  const row = stage.locator("xpath=ancestor::tr");
  assert.equal((await row.innerText()).includes(profileId), true);
}

async function listRealProfileNames() {
  const appData = process.env.APPDATA;
  if (!appData) return [];
  const directory = path.join(appData, "brproxies-launcher", "profiles");
  return readdir(directory).then((names) => names.sort()).catch(() => []);
}

function assertLogsAreRedacted(logChunks) {
  const logs = logChunks.join("");
  for (const forbidden of protectedFixtureValues()) {
    assert.equal(logs.includes(forbidden), false, "QA log exposed a protected fixture value");
  }
}

function assertRedactedPayload(value, label) {
  const serialized = JSON.stringify(value);
  for (const forbidden of protectedFixtureValues()) {
    assert.equal(serialized.includes(forbidden), false, `${label} exposed a protected fixture value`);
  }
}

function protectedFixtureValues() {
  return [syntheticAccount, initialPassword, totpSecret, ...generatedPasswords];
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (lastError) throw lastError;
  throw new Error(message);
}
