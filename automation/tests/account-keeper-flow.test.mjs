import test from "node:test";
import assert from "node:assert/strict";

import { runAccountFlow } from "../account-keeper-flow.mjs";
import { createFixturePage } from "../adapters/fixture-v1.mjs";
import { openaiChatgptAdapter } from "../adapters/openai-chatgpt-v1.mjs";
import { getAdapter } from "../adapters/registry.mjs";

const request = () => ({
  protocol_version: 1,
  type: "start",
  request_id: "req_1",
  adapter_id: "fixture-v1",
  cdp_endpoint: "http://127.0.0.1:9222",
  account: "synthetic@example.test",
  current_password: "synthetic-current",
  new_password: "Synthetic-New-Password-123!",
});

async function execute(states, commands = [], customControl = null) {
  const page = createFixturePage(states);
  const events = [];
  const pending = [...commands];
  const control =
    customControl ??
    {
      throwIfCancelled() {},
      async waitFor(expectedType) {
        if (expectedType === "submit_password") {
          return {
            protocol_version: 1,
            type: "submit_password",
            request_id: "req_1",
          };
        }
        const command = pending.shift();
        if (!command || command.type !== expectedType) {
          throw Object.assign(new Error("protocol_error"), { code: "protocol_error" });
        }
        return { protocol_version: 1, request_id: "req_1", ...command };
      },
    };
  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit: (message) => events.push(message),
    control,
    waitForCommand: async () => {
      const command = pending.shift();
      if (!command) {
        throw new Error("fixture command queue exhausted");
      }
      return { protocol_version: 1, request_id: "req_1", ...command };
    },
  });
  return { page, events };
}

test("runs direct login, password change, logout, and verified re-login", async () => {
  const { page, events } = await execute([
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);
  assert.equal(events.at(-1).type, "verified");
  assert.deepEqual(
    page.actions.map((action) => action.type),
    [
      "open_login",
      "submit_credentials",
      "open_password_change",
      "submit_password_change",
      "logout",
      "open_login",
      "submit_credentials",
      "verify_signed_in",
    ],
  );
  assert.equal(page.actions[1].password, "synthetic-current");
  assert.equal(page.actions[6].password, "Synthetic-New-Password-123!");
});

test("requests authorization before submitting the password change", async () => {
  const page = createFixturePage([
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);
  const events = [];
  let authorize;
  const authorization = new Promise((resolve) => {
    authorize = resolve;
  });
  const flow = runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit: (message) => events.push(message),
    control: {
      throwIfCancelled() {},
      async waitFor(expectedType) {
        assert.equal(expectedType, "submit_password");
        return authorization;
      },
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "password_submit_required"), true);
  assert.equal(
    page.actions.some((action) => action.type === "submit_password_change"),
    false,
  );

  authorize({
    protocol_version: 1,
    type: "submit_password",
    request_id: "req_1",
  });
  await flow;
  assert.equal(events.at(-1).type, "verified");
});

test("installs the password authorization waiter before emitting the request", async () => {
  const sequence = [];
  const page = createFixturePage([
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);
  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit(message) {
      if (message.type === "password_submit_required") sequence.push("emit");
    },
    control: {
      throwIfCancelled() {},
      async waitFor(expectedType) {
        assert.equal(expectedType, "submit_password");
        sequence.push("wait");
        return {
          protocol_version: 1,
          type: "submit_password",
          request_id: "req_1",
        };
      },
    },
  });

  assert.deepEqual(sequence, ["wait", "emit"]);
});

test("requests TOTP for both sign-ins without exposing secret", async () => {
  const { page, events } = await execute(
    [
      "login_ready",
      "totp_required",
      "signed_in",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "totp_required",
      "signed_in",
    ],
    [
      { type: "totp_code", code: "123456" },
      { type: "totp_code", code: "654321" },
    ],
  );
  assert.equal(events.filter((event) => event.type === "totp_required").length, 2);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["123456", "654321"],
  );
  assert.equal(JSON.stringify(events).includes("JBSWY"), false);
});

test("requests at most two TOTP codes then pauses for manual recovery", async () => {
  const { events } = await execute(
    [
      "login_ready",
      "totp_required",
      "totp_rejected",
      "totp_rejected",
      "signed_in",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "signed_in",
    ],
    [
      { type: "totp_code", code: "123456" },
      { type: "totp_code", code: "654321" },
      { type: "resume" },
    ],
  );
  assert.equal(events.filter((event) => event.type === "totp_required").length, 2);
  assert.equal(
    events.some(
      (event) => event.type === "manual_required" && event.reason === "security_challenge",
    ),
    true,
  );
});

test("does not request another TOTP while the submitted form is unchanged", async () => {
  const { page, events } = await execute(
    [
      "login_ready",
      "totp_required",
      "totp_required",
      "totp_required",
      "signed_in",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "signed_in",
    ],
    [{ type: "totp_code", code: "123456" }],
  );
  assert.equal(events.filter((event) => event.type === "totp_required").length, 1);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["123456"],
  );
});

test("cancellation after password submission reports unknown credential state", async () => {
  const page = createFixturePage([
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
  ]);
  const events = [];
  const control = {
    throwIfCancelled() {
      if (page.actions.some((action) => action.type === "submit_password_change")) {
        throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      }
    },
    async waitFor(expectedType) {
      assert.equal(expectedType, "submit_password");
      return {
        protocol_version: 1,
        type: "submit_password",
        request_id: "req_1",
      };
    },
  };
  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit: (message) => events.push(message),
    control,
    waitForCommand: async () => ({ type: "cancel", request_id: "req_1" }),
  });
  assert.equal(events.at(-1).type, "failed");
  assert.equal(events.at(-1).code, "credential_state_unknown");
  assert.equal(page.actions.some((action) => action.type === "logout"), false);
});

test("cancellation after password acceptance remains unknown until re-login verifies", async () => {
  const page = createFixturePage([
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
  ]);
  const events = [];
  const control = {
    throwIfCancelled() {
      if (events.some((event) => event.type === "password_changed")) {
        throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      }
    },
    async waitFor(expectedType) {
      assert.equal(expectedType, "submit_password");
      return {
        protocol_version: 1,
        type: "submit_password",
        request_id: "req_1",
      };
    },
  };
  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit: (message) => events.push(message),
    control,
  });
  assert.equal(events.at(-1).code, "credential_state_unknown");
  assert.equal(page.actions.some((action) => action.type === "logout"), false);
});

test("cancellation before password submit authorization retains original credential state", async () => {
  const page = createFixturePage([
    "login_ready",
    "signed_in",
    "password_change_ready",
  ]);
  const events = [];
  const control = {
    throwIfCancelled() {},
    async waitFor(expectedType) {
      assert.equal(expectedType, "submit_password");
      return { protocol_version: 1, type: "cancel", request_id: "req_1" };
    },
  };
  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit: (message) => events.push(message),
    control,
  });
  assert.equal(events.at(-1).code, "cancelled");
  assert.equal(page.actions.some((action) => action.type === "submit_password_change"), false);
});

test("cancellation after password submit authorization reports unknown state", async () => {
  const page = createFixturePage([
    "login_ready",
    "signed_in",
    "password_change_ready",
  ]);
  const events = [];
  let authorized = false;
  const control = {
    throwIfCancelled() {
      if (authorized) {
        throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      }
    },
    async waitFor(expectedType) {
      assert.equal(expectedType, "submit_password");
      authorized = true;
      return {
        protocol_version: 1,
        type: "submit_password",
        request_id: "req_1",
      };
    },
  };
  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit: (message) => events.push(message),
    control,
  });
  assert.equal(events.at(-1).code, "credential_state_unknown");
  assert.equal(page.actions.some((action) => action.type === "submit_password_change"), false);
});

test("verification rejects a signed-in state without submitting new credentials", async () => {
  const { page, events } = await execute([
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "signed_in",
  ]);
  assert.equal(events.at(-1).type, "failed");
  assert.equal(events.at(-1).code, "credential_state_unknown");
  assert.equal(
    page.actions.filter((action) => action.type === "submit_credentials").length,
    1,
  );
  assert.equal(
    page.actions.some((action) => action.type === "verify_signed_in"),
    false,
  );
});

test("pauses for CAPTCHA and resumes only after operator command", async () => {
  const { events } = await execute(
    [
      "login_ready",
      {
        state: "manual_required",
        reason: "captcha",
        url: "https://auth.openai.com/challenge?token=secret#fragment",
      },
      "signed_in",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "signed_in",
    ],
    [{ type: "resume" }],
  );
  const manual = events.find((event) => event.type === "manual_required");
  assert.equal(manual.reason, "captcha");
  assert.equal(manual.url, "https://auth.openai.com/challenge");
});

test("supports official forgot-password email reset with manual resume", async () => {
  const { events } = await execute(
    [
      "login_ready",
      "signed_in",
      {
        state: "manual_required",
        reason: "email_verification",
        url: "https://auth.openai.com/password/reset?ticket=secret",
      },
      "password_change_ready",
      "password_changed",
      "login_ready",
      "signed_in",
    ],
    [{ type: "resume" }],
  );
  const manual = events.find(
    (event) => event.type === "manual_required" && event.reason === "email_verification",
  );
  assert.equal(manual.url, "https://auth.openai.com/password/reset");
  assert.equal(events.at(-1).type, "verified");
});

test("refuses unsupported social login", async () => {
  const { page, events } = await execute(["unsupported_login_method"]);
  assert.equal(events.at(-1).type, "failed");
  assert.equal(events.at(-1).code, "unsupported_login_method");
  assert.deepEqual(page.actions.map((action) => action.type), ["open_login"]);
});

test("refuses changed page structure without guessing", async () => {
  const { page, events } = await execute(["flow_changed"]);
  assert.equal(events.at(-1).type, "failed");
  assert.equal(events.at(-1).code, "flow_changed");
  assert.deepEqual(page.actions.map((action) => action.type), ["open_login"]);
});

test("requires explicit registered adapter", () => {
  assert.equal(getAdapter("openai-chatgpt-v1").id, "openai-chatgpt-v1");
  assert.throws(() => getAdapter("unknown-v1"), /Unsupported Account Keeper adapter/);
});

test("OpenAI logout treats password reset confirmation as signed out", async () => {
  const page = fakeOpenAiPage({
    url: "https://auth.openai.com/password/reset",
    visible: [{ role: "heading", label: "Password reset" }],
  });
  await openaiChatgptAdapter.logout(page);
  assert.equal(page.clicks, 0);
});

test("OpenAI adapter does not treat public ChatGPT pages as signed in", async () => {
  const publicPage = fakeOpenAiPage({ url: "https://chatgpt.com/share/synthetic" });
  assert.equal(await openaiChatgptAdapter.classify(publicPage), "flow_changed");

  const signedInPage = fakeOpenAiPage({
    url: "https://chatgpt.com/",
    visible: [{ role: "button", label: "Profile menu" }],
  });
  assert.equal(await openaiChatgptAdapter.classify(signedInPage), "signed_in");
});

test("OpenAI adapter reports an explicit rejected TOTP state", async () => {
  const page = fakeOpenAiPage({
    url: "https://auth.openai.com/u/mfa-otp-challenge",
    visible: [
      { role: "alert", label: "Incorrect verification code" },
      { role: "textbox", label: "Verification code" },
    ],
  });
  assert.equal(await openaiChatgptAdapter.classify(page), "totp_rejected");
});

test("OpenAI adapter checks cancellation between fill and click", async () => {
  let cancelled = false;
  let clicks = 0;
  const input = {
    first() {
      return this;
    },
    async isVisible() {
      return true;
    },
    async fill() {
      cancelled = true;
    },
  };
  const button = {
    first() {
      return this;
    },
    async isVisible() {
      return true;
    },
    async click() {
      clicks += 1;
    },
  };
  const page = {
    locator() {
      return input;
    },
    getByRole() {
      return button;
    },
  };
  const control = {
    throwIfCancelled() {
      if (cancelled) {
        throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      }
    },
  };
  await assert.rejects(
    openaiChatgptAdapter.submitCredentials(
      page,
      { account: "synthetic@example.test", password: "synthetic" },
      { control },
    ),
    /cancelled/,
  );
  assert.equal(clicks, 0);
});

test("emitted worker messages contain no credentials, tokens, HTML, or account", async () => {
  const { events } = await execute([
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);
  const text = JSON.stringify(events).toLowerCase();
  for (const forbidden of [
    "synthetic@example.test",
    "synthetic-current",
    "synthetic-new-password",
    "cookie",
    "access_token",
    "refresh_token",
    "authorization",
    "<html",
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

function fakeOpenAiPage({ url, visible = [] }) {
  const page = {
    clicks: 0,
    url: () => url,
    locator: () => fakeLocator(page, false),
    getByRole: (role, options = {}) => {
      const match = visible.some((item) => {
        if (item.role !== role) return false;
        if (!options.name) return true;
        return options.name instanceof RegExp
          ? options.name.test(item.label)
          : options.name === item.label;
      });
      return fakeLocator(page, match);
    },
  };
  return page;
}

function fakeLocator(page, isVisible) {
  return {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return isVisible;
    },
    async count() {
      return isVisible ? 1 : 0;
    },
    async click() {
      page.clicks += 1;
    },
    async fill() {},
    nth() {
      return this;
    },
  };
}
