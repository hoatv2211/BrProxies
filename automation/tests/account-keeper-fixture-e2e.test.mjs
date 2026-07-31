import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { chromium } from "patchright";

import { runAccountFlow } from "../account-keeper-flow.mjs";
import { fixtureAdapter } from "../adapters/fixture-v1.mjs";
import { startAccountKeeperFixture } from "../fixtures/account-keeper-fixture-server.mjs";

const ACCOUNT = "synthetic@example.test";
const SECOND_ACCOUNT = "secondary@example.test";
const ORIGINAL_PASSWORD = "Synthetic-Current-123!";
const SECOND_PASSWORD = "Secondary-Current-789!";
const NEW_PASSWORD = "Synthetic-New-Password-456!";
const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SECOND_TOTP_SECRET = "JBSWY3DPEHPK3PXP";
const AUTOMATION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("fixture accepts synthetic accounts only", async () => {
  await assert.rejects(
    startAccountKeeperFixture({
      accounts: [{
        account: "real@example.com",
        password: ORIGINAL_PASSWORD,
        totpSecret: TOTP_SECRET,
      }],
    }),
    /synthetic account/i,
  );
});

test("fixture generates RFC-compatible TOTP without exposing Base32 secrets", async (context) => {
  const fixture = await startAccountKeeperFixture({ accounts: fixtureAccounts() });
  context.after(() => fixture.close());

  assert.equal(fixture.currentTotp(ACCOUNT, 59_000), "287082");
  const response = await fetch(
    `${fixture.origin}/_fixture/totp?account=${encodeURIComponent(ACCOUNT)}`,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.code, fixture.currentTotp(ACCOUNT));

  const stateText = JSON.stringify(await fixture.inspect());
  assert.equal(stateText.includes(TOTP_SECRET), false);
  assert.equal(stateText.includes(SECOND_TOTP_SECRET), false);
});

test("fixture keeps independent account password and login state", async (context) => {
  const fixture = await startAccountKeeperFixture({ accounts: fixtureAccounts() });
  context.after(() => fixture.close());
  const primary = createHttpClient(fixture.origin);
  const secondary = createHttpClient(fixture.origin);

  assertRedirect(
    await primary.postForm("/session", {
      account: ACCOUNT,
      password: ORIGINAL_PASSWORD,
    }),
    "/manual-challenge",
  );
  await fixture.completeManualChallenge(ACCOUNT);
  assertRedirect(await primary.get("/manual-challenge"), "/totp");
  assertRedirect(
    await primary.postForm("/totp", { code: fixture.currentTotp(ACCOUNT) }),
    "/home",
  );
  assertRedirect(
    await primary.postForm("/password", {
      current_password: ORIGINAL_PASSWORD,
      new_password: NEW_PASSWORD,
      confirm_password: NEW_PASSWORD,
    }),
    "/password-changed",
  );
  assertRedirect(await primary.postForm("/logout"), "/login");
  assertRedirect(
    await primary.postForm("/session", {
      account: ACCOUNT,
      password: ORIGINAL_PASSWORD,
    }),
    "/login?error=invalid",
  );
  assertRedirect(
    await primary.postForm("/session", {
      account: ACCOUNT,
      password: NEW_PASSWORD,
    }),
    "/totp",
  );
  assertRedirect(
    await primary.postForm("/totp", { code: fixture.currentTotp(ACCOUNT) }),
    "/home",
  );

  assertRedirect(
    await secondary.postForm("/session", {
      account: SECOND_ACCOUNT,
      password: SECOND_PASSWORD,
    }),
    "/totp",
  );
  assertRedirect(
    await secondary.postForm("/totp", { code: fixture.currentTotp(SECOND_ACCOUNT) }),
    "/home",
  );

  const state = await fixture.inspect();
  assert.deepEqual(state.accounts[ACCOUNT], {
    activeSessions: 1,
    loginAttempts: 3,
    logoutCount: 1,
    manualChallengeCompleted: true,
    manualChallengeRequired: true,
    passwordChanges: 1,
    successfulLogins: 2,
  });
  assert.deepEqual(state.accounts[SECOND_ACCOUNT], {
    activeSessions: 1,
    loginAttempts: 1,
    logoutCount: 0,
    manualChallengeCompleted: false,
    manualChallengeRequired: false,
    passwordChanges: 0,
    successfulLogins: 1,
  });
});

test("fixture control API completes, re-arms, inspects, and resets challenges", async (context) => {
  const fixture = await startAccountKeeperFixture({ accounts: fixtureAccounts() });
  context.after(() => fixture.close());
  const client = createHttpClient(fixture.origin);

  const completeResponse = await fetch(`${fixture.origin}/_fixture/manual-challenge/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  assert.equal(completeResponse.status, 200);
  assert.equal((await completeResponse.json()).completed, true);

  assertRedirect(
    await client.postForm("/session", {
      account: ACCOUNT,
      password: ORIGINAL_PASSWORD,
    }),
    "/totp",
  );
  assertRedirect(
    await client.postForm("/totp", { code: fixture.currentTotp(ACCOUNT) }),
    "/home",
  );
  assertRedirect(
    await client.postForm("/password", {
      current_password: ORIGINAL_PASSWORD,
      new_password: NEW_PASSWORD,
      confirm_password: NEW_PASSWORD,
    }),
    "/password-changed",
  );
  const beforeArm = (await fixture.inspect()).accounts[ACCOUNT];

  await fixture.armManualChallenge(ACCOUNT);
  let state = await fixture.inspect();
  assert.equal(state.accounts[ACCOUNT].manualChallengeCompleted, false);
  assert.equal(state.accounts[ACCOUNT].activeSessions, beforeArm.activeSessions);
  assert.equal(state.accounts[ACCOUNT].passwordChanges, beforeArm.passwordChanges);
  assert.equal(state.accounts[ACCOUNT].successfulLogins, beforeArm.successfulLogins);

  assertRedirect(await client.postForm("/logout"), "/login");
  assertRedirect(
    await client.postForm("/session", {
      account: ACCOUNT,
      password: ORIGINAL_PASSWORD,
    }),
    "/login?error=invalid",
  );
  assertRedirect(
    await client.postForm("/session", {
      account: ACCOUNT,
      password: NEW_PASSWORD,
    }),
    "/manual-challenge",
  );

  const armResponse = await fetch(`${fixture.origin}/_fixture/manual-challenge/arm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: ACCOUNT }),
  });
  assert.equal(armResponse.status, 200);
  assert.equal((await armResponse.json()).armed, true);

  const stateResponse = await fetch(`${fixture.origin}/_fixture/state`);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), await fixture.inspect());

  const resetResponse = await fetch(`${fixture.origin}/_fixture/reset`, { method: "POST" });
  assert.equal(resetResponse.status, 200);
  state = await resetResponse.json();
  assert.deepEqual(state, await fixture.inspect());
  assert.equal(state.accounts[ACCOUNT].manualChallengeCompleted, false);
  assert.equal(state.accounts[ACCOUNT].successfulLogins, 0);
  assert.equal(state.accounts[SECOND_ACCOUNT].successfulLogins, 0);
});

function fixtureAccounts() {
  return [
    {
      account: ACCOUNT,
      password: ORIGINAL_PASSWORD,
      totpSecret: TOTP_SECRET,
      manualChallenge: true,
    },
    {
      account: SECOND_ACCOUNT,
      password: SECOND_PASSWORD,
      totpSecret: SECOND_TOTP_SECRET,
    },
  ];
}

function createHttpClient(origin) {
  let cookie = null;
  async function request(pathname, options = {}) {
    const headers = new Headers(options.headers);
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${origin}${pathname}`, {
      ...options,
      headers,
      redirect: "manual",
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";", 1)[0];
    return response;
  }
  return {
    get: (pathname) => request(pathname),
    postForm: (pathname, values = {}) => request(pathname, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    }),
  };
}

function assertRedirect(response, location) {
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), location);
}

test("runs the complete fixture flow in a real browser", async (context) => {
  const fixture = await startAccountKeeperFixture({ accounts: [fixtureAccounts()[0]] });
  const browser = await chromium.launch({ headless: true });
  context.after(async () => {
    await browser.close();
    await fixture.close();
  });

  const page = await browser.newPage();
  const events = [];
  const adapter = {
    ...fixtureAdapter,
    allowedOrigins: [fixture.origin],
    loginUrl: `${fixture.origin}/login`,
  };

  await runAccountFlow({
    page,
    adapter,
    request: {
      protocol_version: 1,
      type: "start",
      request_id: "fixture_e2e",
      adapter_id: "fixture-v1",
      cdp_endpoint: "http://127.0.0.1:9222",
      account: ACCOUNT,
      current_password: ORIGINAL_PASSWORD,
      new_password: NEW_PASSWORD,
    },
    emit: (message) => events.push(message),
    control: {
      throwIfCancelled() {},
      async waitFor(expectedType) {
        let command;
        if (expectedType === "resume") {
          const navigated = page.waitForURL(`${fixture.origin}/totp`);
          await fixture.completeManualChallenge(ACCOUNT);
          await navigated;
          command = { type: "resume" };
        } else if (expectedType === "totp_code") {
          command = { type: "totp_code", code: fixture.currentTotp(ACCOUNT) };
        } else if (expectedType === "submit_password") {
          command = { type: "submit_password" };
        } else {
          assert.fail(`unexpected fixture command ${expectedType}`);
        }
        return {
          protocol_version: 1,
          request_id: "fixture_e2e",
          ...command,
        };
      },
    },
  });

  assert.equal(
    events.at(-1)?.type,
    "verified",
    JSON.stringify({ events, url: page.url() }),
  );
  const state = (await fixture.inspect()).accounts[ACCOUNT];
  assert.equal(state.passwordChanges, 1);
  assert.equal(state.successfulLogins, 2);
  assert.equal(state.logoutCount, 1);
  assert.equal(state.manualChallengeCompleted, true);
  const output = JSON.stringify(events).toLowerCase();
  for (const forbidden of [ACCOUNT, ORIGINAL_PASSWORD, NEW_PASSWORD, "cookie", "token"]) {
    assert.equal(output.includes(forbidden.toLowerCase()), false, forbidden);
  }
});

test("runs the complete fixture flow through the worker CDP protocol", async (context) => {
  const fixture = await startAccountKeeperFixture({ accounts: [fixtureAccounts()[0]] });
  const browser = await launchCdpBrowser();
  context.after(async () => {
    await browser.close();
    await fixture.close();
  });

  const worker = spawn(process.execPath, ["account-keeper-worker.mjs"], {
    cwd: AUTOMATION_DIR,
    env: {
      ...process.env,
      ACCOUNT_KEEPER_FIXTURE_ORIGIN: fixture.origin,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const errors = [];
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => errors.push(chunk));

  const requestId = "fixture_worker_e2e";
  worker.stdin.write(`${JSON.stringify({
    protocol_version: 1,
    type: "start",
    request_id: requestId,
    adapter_id: "fixture-v1",
    cdp_endpoint: browser.endpoint,
    account: ACCOUNT,
    current_password: ORIGINAL_PASSWORD,
    new_password: NEW_PASSWORD,
  })}\n`);

  const events = [];
  const lines = createInterface({ input: worker.stdout });
  for await (const line of lines) {
    const message = JSON.parse(line);
    events.push(message);
    if (message.type === "manual_required") {
      const response = await fetch(`${fixture.origin}/_fixture/manual-challenge/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: ACCOUNT }),
      });
      assert.equal(response.status, 200);
      await waitForCdpPageUrl(browser.endpoint, `${fixture.origin}/totp`);
      worker.stdin.write(`${JSON.stringify({
        protocol_version: 1,
        type: "resume",
        request_id: requestId,
      })}\n`);
    } else if (message.type === "totp_required") {
      worker.stdin.write(`${JSON.stringify({
        protocol_version: 1,
        type: "totp_code",
        request_id: requestId,
        code: fixture.currentTotp(ACCOUNT),
      })}\n`);
    } else if (message.type === "password_submit_required") {
      worker.stdin.write(`${JSON.stringify({
        protocol_version: 1,
        type: "submit_password",
        request_id: requestId,
      })}\n`);
    }
  }
  const exitCode = await waitForExit(worker);

  assert.equal(exitCode, 0, errors.join(""));
  assert.equal(
    events.at(-1)?.type,
    "verified",
    JSON.stringify({ events, stderr: errors.join("") }),
  );
  const state = (await fixture.inspect()).accounts[ACCOUNT];
  assert.equal(state.passwordChanges, 1);
  assert.equal(state.successfulLogins, 2);
  assert.equal(state.logoutCount, 1);
  assert.equal(state.manualChallengeCompleted, true);
});

async function launchCdpBrowser() {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "brproxies-account-keeper-fixture-"));
  const executable = chromium.executablePath();
  const child = spawn(executable, [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], {
    stdio: "ignore",
    windowsHide: true,
  });
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let port = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`fixture Chromium exited with code ${child.exitCode}`);
    }
    const text = await readFile(portFile, "utf8").catch(() => "");
    const candidate = Number(text.split(/\r?\n/, 1)[0]);
    if (Number.isInteger(candidate) && candidate > 0) {
      port = candidate;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (port === null) {
    child.kill();
    throw new Error("fixture Chromium CDP endpoint was not ready");
  }
  return {
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      if (child.exitCode === null) child.kill();
      await waitForExit(child).catch(() => {});
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

async function waitForCdpPageUrl(endpoint, expectedUrl) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${endpoint}/json/list`).catch(() => null);
    if (response?.ok) {
      const targets = await response.json();
      if (targets.some((target) => target.url === expectedUrl)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`fixture Chromium did not navigate to ${expectedUrl}`);
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}
