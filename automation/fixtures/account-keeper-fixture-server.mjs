import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

const SESSION_COOKIE = "account_keeper_fixture_session";
const TOTP_DIGITS = 6;
const TOTP_STEP_MS = 30_000;

export async function startAccountKeeperFixture({ accounts, now = () => Date.now() } = {}) {
  const accountStates = createAccountStates(accounts);
  const sessions = new Map();
  const server = http.createServer(async (request, response) => {
    try {
      await routeRequest({ request, response, accountStates, sessions, now });
    } catch {
      json(response, 500, { error: "fixture_error" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    await closeServer(server);
    throw new Error("fixture server address is unavailable");
  }

  const inspect = () => inspectState(accountStates, sessions);
  return {
    origin: `http://127.0.0.1:${address.port}`,
    currentTotp(account, at = now()) {
      return totpFor(accountState(accountStates, account).totpKey, at);
    },
    completeManualChallenge(account) {
      return completeManualChallenge(accountState(accountStates, account));
    },
    armManualChallenge(account) {
      return armManualChallenge(accountState(accountStates, account));
    },
    reset() {
      resetFixture(accountStates, sessions);
      return inspect();
    },
    inspect,
    close: () => closeServer(server),
  };
}

async function routeRequest({ request, response, accountStates, sessions, now }) {
  if (!isLoopbackRequest(request)) {
    return json(response, 403, { error: "loopback_only" });
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/_fixture/state") {
    return json(response, 200, inspectState(accountStates, sessions));
  }
  if (request.method === "GET" && url.pathname === "/_fixture/totp") {
    const state = accountStates.get(url.searchParams.get("account"));
    if (!state) return json(response, 404, { error: "unknown_account" });
    return json(response, 200, { code: totpFor(state.totpKey, now()) });
  }
  if (request.method === "POST" && url.pathname === "/_fixture/manual-challenge/complete") {
    const body = await readJson(request);
    const state = accountStates.get(body.account);
    if (!state) return json(response, 404, { error: "unknown_account" });
    return json(response, 200, completeManualChallenge(state));
  }
  if (request.method === "POST" && url.pathname === "/_fixture/manual-challenge/arm") {
    const body = await readJson(request);
    const state = accountStates.get(body.account);
    if (!state) return json(response, 404, { error: "unknown_account" });
    return json(response, 200, armManualChallenge(state));
  }
  if (request.method === "POST" && url.pathname === "/_fixture/reset") {
    resetFixture(accountStates, sessions);
    return json(response, 200, inspectState(accountStates, sessions));
  }

  if (request.method === "GET" && url.pathname === "/login") {
    return html(response, loginPage(url.searchParams.has("error")));
  }
  if (request.method === "POST" && url.pathname === "/session") {
    const form = await readForm(request);
    const state = accountStates.get(form.get("account"));
    if (state) state.loginAttempts += 1;
    if (!state || form.get("password") !== state.password) {
      return redirect(response, "/login?error=invalid");
    }
    const sessionId = randomUUID();
    sessions.set(sessionId, { account: state.account, signedIn: false });
    return redirect(
      response,
      challengePending(state) ? "/manual-challenge" : "/totp",
      { "set-cookie": sessionCookie(sessionId) },
    );
  }
  if (request.method === "GET" && url.pathname === "/manual-challenge") {
    const session = sessionFor(request, sessions);
    if (!session) return redirect(response, "/login");
    const state = accountState(accountStates, session.account);
    if (!challengePending(state)) return redirect(response, "/totp");
    return html(response, manualChallengePage());
  }
  if (request.method === "GET" && url.pathname === "/_fixture/manual-challenge/status") {
    const session = sessionFor(request, sessions);
    if (!session) return json(response, 401, { error: "login_required" });
    const state = accountState(accountStates, session.account);
    return json(response, 200, { completed: !challengePending(state) });
  }
  if (request.method === "GET" && url.pathname === "/totp") {
    const session = sessionFor(request, sessions);
    if (!session) return redirect(response, "/login");
    const state = accountState(accountStates, session.account);
    if (challengePending(state)) return redirect(response, "/manual-challenge");
    return html(response, totpPage(url.searchParams.has("error")));
  }
  if (request.method === "POST" && url.pathname === "/totp") {
    const session = sessionFor(request, sessions);
    if (!session) return redirect(response, "/login");
    const state = accountState(accountStates, session.account);
    if (challengePending(state)) return redirect(response, "/manual-challenge");
    const form = await readForm(request);
    if (!verifyTotp(state.totpKey, form.get("code"), now())) {
      return redirect(response, "/totp?error=rejected");
    }
    session.signedIn = true;
    state.successfulLogins += 1;
    return redirect(response, "/home");
  }
  if (request.method === "GET" && url.pathname === "/home") {
    const session = signedInSession(request, sessions);
    return session ? html(response, homePage()) : redirect(response, "/login");
  }
  if (request.method === "GET" && url.pathname === "/password") {
    const session = signedInSession(request, sessions);
    return session ? html(response, passwordPage()) : redirect(response, "/login");
  }
  if (request.method === "POST" && url.pathname === "/password") {
    const session = signedInSession(request, sessions);
    if (!session) return redirect(response, "/login");
    const state = accountState(accountStates, session.account);
    const form = await readForm(request);
    const newPassword = form.get("new_password");
    if (
      form.get("current_password") !== state.password
      || typeof newPassword !== "string"
      || newPassword.length === 0
      || newPassword !== form.get("confirm_password")
    ) {
      return redirect(response, "/password?error=rejected");
    }
    state.password = newPassword;
    state.passwordChanges += 1;
    return redirect(response, "/password-changed");
  }
  if (request.method === "GET" && url.pathname === "/password-changed") {
    const session = signedInSession(request, sessions);
    return session ? html(response, passwordChangedPage()) : redirect(response, "/login");
  }
  if (request.method === "POST" && url.pathname === "/logout") {
    const sessionId = sessionIdFor(request);
    const session = sessionId ? sessions.get(sessionId) : null;
    if (session?.signedIn) {
      accountState(accountStates, session.account).logoutCount += 1;
    }
    if (sessionId) sessions.delete(sessionId);
    return redirect(response, "/login", { "set-cookie": expiredSessionCookie() });
  }
  response.writeHead(404).end("Not found");
}

function createAccountStates(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error("fixture requires at least one synthetic account");
  }
  const states = new Map();
  for (const config of accounts) {
    if (!isSyntheticAccount(config?.account)) {
      throw new Error("fixture requires synthetic account addresses under .test");
    }
    if (states.has(config.account)) {
      throw new Error("fixture synthetic accounts must be unique");
    }
    if (typeof config.password !== "string" || config.password.length === 0) {
      throw new Error("fixture synthetic account requires a password");
    }
    states.set(config.account, {
      account: config.account,
      initialPassword: config.password,
      password: config.password,
      totpKey: decodeBase32(config.totpSecret),
      initialManualChallengeRequired: config.manualChallenge === true,
      manualChallengeRequired: config.manualChallenge === true,
      manualChallengeCompleted: false,
      loginAttempts: 0,
      successfulLogins: 0,
      passwordChanges: 0,
      logoutCount: 0,
    });
  }
  return states;
}

function inspectState(accountStates, sessions) {
  const accounts = {};
  for (const state of accountStates.values()) {
    accounts[state.account] = {
      activeSessions: [...sessions.values()].filter(
        (session) => session.account === state.account && session.signedIn,
      ).length,
      loginAttempts: state.loginAttempts,
      logoutCount: state.logoutCount,
      manualChallengeCompleted: state.manualChallengeCompleted,
      manualChallengeRequired: state.manualChallengeRequired,
      passwordChanges: state.passwordChanges,
      successfulLogins: state.successfulLogins,
    };
  }
  return { accounts };
}

function accountState(accountStates, account) {
  const state = accountStates.get(account);
  if (!state) throw new Error("unknown synthetic account");
  return state;
}

function challengePending(state) {
  return state.manualChallengeRequired && !state.manualChallengeCompleted;
}

function completeManualChallenge(state) {
  state.manualChallengeCompleted = true;
  return { completed: true };
}

function armManualChallenge(state) {
  state.manualChallengeRequired = true;
  state.manualChallengeCompleted = false;
  return { armed: true };
}

function resetFixture(accountStates, sessions) {
  sessions.clear();
  for (const state of accountStates.values()) {
    state.password = state.initialPassword;
    state.manualChallengeRequired = state.initialManualChallengeRequired;
    state.manualChallengeCompleted = false;
    state.loginAttempts = 0;
    state.successfulLogins = 0;
    state.passwordChanges = 0;
    state.logoutCount = 0;
  }
}

function verifyTotp(key, code, at) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  for (const offset of [-1, 0, 1]) {
    if (totpFor(key, at + offset * TOTP_STEP_MS) === code) return true;
  }
  return false;
}

function totpFor(key, at) {
  if (!Number.isFinite(at) || at < 0) throw new Error("invalid TOTP timestamp");
  const counter = BigInt(Math.floor(at / TOTP_STEP_MS));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, "0");
}

function decodeBase32(secret) {
  if (typeof secret !== "string") throw new Error("invalid Base32 secret");
  const normalized = secret.toUpperCase().replace(/\s+/g, "").replace(/=+$/, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
    throw new Error("invalid Base32 secret");
  }
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of normalized) {
    const digit = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length === 0) throw new Error("invalid Base32 secret");
  return Buffer.from(bytes);
}

function isSyntheticAccount(account) {
  return typeof account === "string" && /^[^@\s]+@[^@\s]+\.test$/i.test(account);
}

function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sessionFor(request, sessions) {
  const sessionId = sessionIdFor(request);
  return sessionId ? sessions.get(sessionId) ?? null : null;
}

function signedInSession(request, sessions) {
  const session = sessionFor(request, sessions);
  return session?.signedIn ? session : null;
}

function sessionIdFor(request) {
  const cookieHeader = request.headers.cookie ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return value.join("=");
  }
  return null;
}

function sessionCookie(sessionId) {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/`;
}

function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function loginPage(invalid) {
  return page("Fixture login", `
    <h1>Fixture login</h1>
    ${invalid ? '<p role="alert">Invalid credentials</p>' : ""}
    <form method="post" action="/session">
      <label>Account <input name="account" autocomplete="username"></label>
      <label>Password <input name="password" type="password" autocomplete="current-password"></label>
      <button type="submit">Sign in</button>
    </form>
  `);
}

function manualChallengePage() {
  return page("Fixture manual challenge", `
    <main data-testid="manual-challenge">
      <h1>Manual challenge required</h1>
      <p>Complete the local fixture challenge, then resume automation.</p>
    </main>
    <script>
      const poll = async () => {
        try {
          const response = await fetch("/_fixture/manual-challenge/status", { cache: "no-store" });
          if (response.ok && (await response.json()).completed) {
            location.replace("/totp");
            return;
          }
        } catch {}
        setTimeout(poll, 25);
      };
      poll();
    </script>
  `);
}

function totpPage(rejected) {
  return page("Fixture verification", `
    <h1>Verification required</h1>
    ${rejected ? '<p role="alert">Verification code rejected</p>' : ""}
    <form method="post" action="/totp">
      <label>Verification code <input name="code" inputmode="numeric" autocomplete="one-time-code"></label>
      <button type="submit">Verify</button>
    </form>
  `);
}

function homePage() {
  return page("Fixture home", `
    <h1>Account home</h1>
    <a href="/password">Change password</a>
  `);
}

function passwordPage() {
  return page("Fixture password", `
    <h1>Change password</h1>
    <form method="post" action="/password">
      <label>Current password <input name="current_password" type="password" autocomplete="current-password"></label>
      <label>New password <input name="new_password" type="password" autocomplete="new-password"></label>
      <label>Confirm new password <input name="confirm_password" type="password" autocomplete="new-password"></label>
      <button type="submit">Update password</button>
    </form>
  `);
}

function passwordChangedPage() {
  return page("Fixture password changed", `
    <h1>Password changed</h1>
    <p role="status">Password changed successfully</p>
    <form method="post" action="/logout"><button type="submit">Log out</button></form>
  `);
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function html(response, body) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, { ...headers, location });
  response.end();
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readForm(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
