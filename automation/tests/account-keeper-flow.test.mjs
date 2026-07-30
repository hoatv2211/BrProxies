import test from "node:test";
import assert from "node:assert/strict";

import { runAccountFlow } from "../account-keeper-flow.mjs";
import { CommandControl } from "../account-keeper-worker-runtime.mjs";
import { createFixturePage, fixtureAdapter } from "../adapters/fixture-v1.mjs";
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

function immediateTotpResponder(codes) {
  const commandControl = new CommandControl("req_1");
  const accepted = [];
  const pendingCodes = [...codes];
  return {
    accepted,
    control: {
      throwIfCancelled() {
        commandControl.throwIfCancelled();
      },
      waitFor(expectedType) {
        if (expectedType === "submit_password") {
          return Promise.resolve({
            protocol_version: 1,
            type: "submit_password",
            request_id: "req_1",
          });
        }
        return commandControl.waitFor(expectedType);
      },
    },
    emit(message, events) {
      events.push(message);
      if (message.type !== "totp_required") return;
      const wasAccepted = commandControl.push({
        protocol_version: 1,
        type: "totp_code",
        request_id: "req_1",
        code: pendingCodes.shift(),
      });
      accepted.push(wasAccepted);
      if (!wasAccepted) {
        setImmediate(() => commandControl.push({
          protocol_version: 1,
          type: "cancel",
          request_id: "req_1",
        }));
      }
    },
  };
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

test("submits a password-change identity challenge once before changing password", async () => {
  const { page, events } = await execute([
    "login_ready",
    "signed_in",
    "identity_challenge",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);

  assert.equal(events.at(-1).type, "verified");
  assert.deepEqual(
    page.actions
      .filter((action) => action.type === "submit_identity_challenge")
      .map((action) => action.currentPassword),
    ["synthetic-current"],
  );
});

test("installs the login TOTP waiter before emitting the request", async () => {
  const page = createFixturePage([
    "login_ready",
    "totp_required",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);
  const events = [];
  const responder = immediateTotpResponder(["123456"]);

  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit: (message) => responder.emit(message, events),
    control: responder.control,
  });

  assert.deepEqual(responder.accepted, [true]);
  assert.equal(events.at(-1).type, "verified");
});

test("installs the password-change TOTP waiter before emitting the request", async () => {
  const page = createFixturePage([
    "login_ready",
    "signed_in",
    "identity_challenge",
    "totp_required",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);
  const events = [];
  const responder = immediateTotpResponder(["123456"]);

  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: request(),
    emit: (message) => responder.emit(message, events),
    control: responder.control,
  });

  assert.deepEqual(responder.accepted, [true]);
  assert.equal(events.at(-1).type, "verified");
});

test("requests a new login TOTP after the pending form transitions away and returns", async () => {
  const { page, events } = await execute(
    [
      "login_ready",
      "totp_required",
      "totp_required",
      "totp_required",
      {
        state: "manual_required",
        reason: "captcha",
        url: "https://auth.openai.com/challenge?ticket=synthetic#fragment",
      },
      "totp_required",
      "signed_in",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "signed_in",
    ],
    [
      { type: "totp_code", code: "123456" },
      { type: "resume" },
      { type: "totp_code", code: "654321" },
    ],
  );

  assert.equal(events.at(-1).type, "verified");
  assert.equal(events.filter((event) => event.type === "totp_required").length, 2);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["123456", "654321"],
  );
});

test("requests a new login TOTP after a direct fast transition away and back", async () => {
  const { page, events } = await execute(
    [
      "login_ready",
      "totp_required",
      {
        state: "manual_required",
        reason: "captcha",
        url: "https://auth.openai.com/challenge?ticket=synthetic#fragment",
      },
      "totp_required",
      "signed_in",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "signed_in",
    ],
    [
      { type: "totp_code", code: "123456" },
      { type: "resume" },
      { type: "totp_code", code: "654321" },
    ],
  );

  assert.equal(events.at(-1).type, "verified");
  assert.equal(events.filter((event) => event.type === "totp_required").length, 2);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["123456", "654321"],
  );
});

test("requests a new password-change TOTP after the pending form transitions away and returns", async () => {
  const { page, events } = await execute(
    [
      "login_ready",
      "signed_in",
      "identity_challenge",
      "totp_required",
      "totp_required",
      {
        state: "manual_required",
        reason: "email_verification",
        url: "https://auth.openai.com/password/reset?ticket=synthetic#fragment",
      },
      "totp_required",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "signed_in",
    ],
    [
      { type: "totp_code", code: "123456" },
      { type: "resume" },
      { type: "totp_code", code: "654321" },
    ],
  );

  assert.equal(events.at(-1).type, "verified");
  assert.equal(events.filter((event) => event.type === "totp_required").length, 2);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["123456", "654321"],
  );
});

test("requests a new password-change TOTP after a direct fast transition away and back", async () => {
  const { page, events } = await execute(
    [
      "login_ready",
      "signed_in",
      "identity_challenge",
      "totp_required",
      {
        state: "manual_required",
        reason: "email_verification",
        url: "https://auth.openai.com/password/reset?ticket=synthetic#fragment",
      },
      "totp_required",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "signed_in",
    ],
    [
      { type: "totp_code", code: "123456" },
      { type: "resume" },
      { type: "totp_code", code: "654321" },
    ],
  );

  assert.equal(events.at(-1).type, "verified");
  assert.equal(events.filter((event) => event.type === "totp_required").length, 2);
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["123456", "654321"],
  );
});

test("uses at most two TOTP attempts after a password-change identity challenge", async () => {
  const { page, events } = await execute(
    [
      "login_ready",
      "signed_in",
      "identity_challenge",
      "totp_required",
      "totp_rejected",
      "totp_rejected",
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

  assert.equal(events.at(-1).type, "verified");
  assert.equal(events.filter((event) => event.type === "totp_required").length, 2);
  assert.equal(
    events.some(
      (event) => event.type === "manual_required" && event.reason === "security_challenge",
    ),
    true,
  );
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["123456", "654321"],
  );
});

test("fails password change when the identity challenge repeats", async () => {
  const { page, events } = await execute([
    "login_ready",
    "signed_in",
    "identity_challenge",
    "identity_challenge",
  ]);

  assert.equal(events.at(-1).type, "failed");
  assert.equal(events.at(-1).code, "password_change_failed");
  assert.equal(
    page.actions.filter((action) => action.type === "submit_identity_challenge").length,
    1,
  );
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

test("OpenAI password-change classifier contextualizes only a visible current password", async () => {
  const passwordPage = fakeOpenAiFormPage({ currentPasswordVisible: true });
  assert.equal(await openaiChatgptAdapter.classify(passwordPage), "login_ready");
  assert.equal(
    await openaiChatgptAdapter.classifyPasswordChange(passwordPage),
    "identity_challenge",
  );

  const emailPage = fakeOpenAiFormPage({ emailVisible: true });
  assert.equal(await openaiChatgptAdapter.classifyPasswordChange(emailPage), "login_ready");
});

test("OpenAI password-change classifier prefers identity over generic security challenge", async () => {
  const securityPage = fakeOpenAiFormPage({
    currentPasswordVisible: true,
    heading: "Verify your identity",
  });
  assert.deepEqual(await openaiChatgptAdapter.classify(securityPage), {
    state: "manual_required",
    reason: "security_challenge",
    url: "https://auth.openai.com/password/reset",
  });
  assert.equal(
    await openaiChatgptAdapter.classifyPasswordChange(securityPage),
    "identity_challenge",
  );

  const captchaPage = fakeOpenAiFormPage({
    captchaVisible: true,
    currentPasswordVisible: true,
  });
  assert.deepEqual(await openaiChatgptAdapter.classifyPasswordChange(captchaPage), {
    state: "manual_required",
    reason: "captcha",
    url: "https://auth.openai.com/password/reset",
  });

  const emailVerificationPage = fakeOpenAiFormPage({
    currentPasswordVisible: true,
    heading: "Check your email",
  });
  assert.deepEqual(await openaiChatgptAdapter.classifyPasswordChange(emailVerificationPage), {
    state: "manual_required",
    reason: "email_verification",
    url: "https://auth.openai.com/password/reset",
  });
});

test("fixture adapter waits for the identity challenge input to disappear", async () => {
  const page = fakeFixtureIdentityPage({ visibleTicks: 2 });
  let cancellationChecks = 0;

  await fixtureAdapter.submitIdentityChallenge(
    page,
    "synthetic-current",
    {
      control: {
        throwIfCancelled() {
          cancellationChecks += 1;
        },
      },
    },
  );

  assert.equal(page.clicks, 1);
  assert.equal(page.waits, 2);
  assert.equal(cancellationChecks > 3, true);
});

test("fixture adapter observes cancellation while waiting for identity transition", async () => {
  let cancelled = false;
  const page = fakeFixtureIdentityPage({
    visibleTicks: 10,
    onWait() {
      cancelled = true;
    },
  });

  await assert.rejects(
    fixtureAdapter.submitIdentityChallenge(
      page,
      "synthetic-current",
      {
        control: {
          throwIfCancelled() {
            if (cancelled) {
              throw Object.assign(new Error("cancelled"), { code: "cancelled" });
            }
          },
        },
      },
    ),
    /cancelled/,
  );
  assert.equal(page.waits, 1);
});

test("OpenAI adapter submits and waits for the identity challenge to leave", async () => {
  let passwordVisibleTicks = 3;
  let submitClicks = 0;
  const page = fakeOpenAiFormPage({
    currentPasswordVisible: () => passwordVisibleTicks > 0,
    onCurrentPasswordFill(value) {
      assert.equal(value, "synthetic-current");
    },
    onSemanticSubmit() {
      submitClicks += 1;
    },
    onWait() {
      passwordVisibleTicks -= 1;
    },
  });

  await openaiChatgptAdapter.submitIdentityChallenge(page, "synthetic-current");

  assert.equal(submitClicks, 1);
  assert.equal(passwordVisibleTicks <= 0, true);
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

test("OpenAI adapter submits localized login forms by semantic type", async () => {
  let totpVisible = false;
  let submitClicks = 0;
  const locator = ({ visible = false, dynamicVisible, onClick, onFill } = {}) => ({
    first() {
      return this;
    },
    async isVisible() {
      return dynamicVisible ? dynamicVisible() : visible;
    },
    async click() {
      onClick?.();
    },
    async fill(value) {
      onFill?.(value);
    },
  });
  const page = {
    locator(selector) {
      if (selector.includes('autocomplete="username"')) {
        return locator({
          visible: true,
          onFill: (value) => assert.equal(value, "synthetic@example.test"),
        });
      }
      if (selector === 'button[type="submit"], input[type="submit"]') {
        return locator({
          visible: true,
          onClick: () => {
            submitClicks += 1;
            totpVisible = true;
          },
        });
      }
      if (selector.includes('autocomplete="one-time-code"')) {
        return locator({ dynamicVisible: () => totpVisible });
      }
      return locator();
    },
    getByRole(_role, options = {}) {
      return locator({
        visible: options.name instanceof RegExp && options.name.test("Tiếp tục"),
      });
    },
    async waitForTimeout() {},
  };

  await openaiChatgptAdapter.submitCredentials(page, {
    account: "synthetic@example.test",
    password: "synthetic",
  });

  assert.equal(submitClicks, 1);
});

test("OpenAI adapter waits for the password form to leave after submit", async () => {
  let passwordVisibleTicks = 3;
  let submitClicks = 0;
  let waitTicks = 0;
  const locator = ({ visible, onClick, onFill } = {}) => ({
    first() {
      return this;
    },
    async isVisible() {
      return Boolean(visible?.());
    },
    async click() {
      onClick?.();
    },
    async fill(value) {
      onFill?.(value);
    },
  });
  const page = {
    locator(selector) {
      if (selector.includes('autocomplete="current-password"')) {
        return locator({
          visible: () => passwordVisibleTicks > 0,
          onFill: (value) => assert.equal(value, "synthetic"),
        });
      }
      if (selector === 'button[type="submit"], input[type="submit"]') {
        return locator({
          visible: () => passwordVisibleTicks > 0,
          onClick: () => {
            submitClicks += 1;
          },
        });
      }
      return locator({ visible: () => false });
    },
    getByRole() {
      return locator({ visible: () => false });
    },
    async waitForTimeout() {
      waitTicks += 1;
      passwordVisibleTicks -= 1;
    },
  };

  await openaiChatgptAdapter.submitCredentials(page, {
    account: "synthetic@example.test",
    password: "synthetic",
  });

  assert.equal(submitClicks, 1);
  assert.equal(passwordVisibleTicks <= 0, true);
  assert.equal(waitTicks, 4);
});

test("OpenAI adapter opens localized password reset by semantic href", async () => {
  let stage = "email";
  let resetClicks = 0;
  const locator = ({ visible, onClick } = {}) => ({
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return Boolean(visible?.());
    },
    async click() {
      onClick?.();
    },
    async fill() {},
  });
  const page = {
    url: () => "https://chatgpt.com/auth/login",
    async goto() {
      stage = "email";
    },
    locator(selector) {
      if (selector.includes('autocomplete="username"')) {
        return locator({ visible: () => stage === "email" });
      }
      if (selector.includes('autocomplete="current-password"')) {
        return locator({ visible: () => stage === "password" });
      }
      if (selector === 'button[type="submit"], input[type="submit"]') {
        return locator({
          visible: () => stage === "email",
          onClick: () => {
            stage = "password";
          },
        });
      }
      if (selector === 'a[href*="reset-password"], a[href*="forgot-password"]') {
        return locator({
          visible: () => stage === "password",
          onClick: () => {
            resetClicks += 1;
          },
        });
      }
      return locator({ visible: () => false });
    },
    getByRole() {
      return locator({ visible: () => false });
    },
    async waitForTimeout() {},
  };

  await openaiChatgptAdapter.openPasswordChange(page, {
    account: "synthetic@example.test",
  });

  assert.equal(resetClicks, 1);
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

function fakeOpenAiFormPage({
  emailVisible = false,
  captchaVisible = false,
  currentPasswordVisible = false,
  heading = null,
  onCurrentPasswordFill,
  onSemanticSubmit,
  onWait,
} = {}) {
  const locator = ({ isVisible = false, onFill, onClick } = {}) => ({
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return typeof isVisible === "function" ? isVisible() : isVisible;
    },
    async fill(value) {
      onFill?.(value);
    },
    async click() {
      onClick?.();
    },
  });
  return {
    url: () => "https://auth.openai.com/password/reset",
    locator(selector) {
      if (selector === "[data-captcha]") {
        return locator({ isVisible: captchaVisible });
      }
      if (selector.includes('autocomplete="username"')) {
        return locator({ isVisible: emailVisible });
      }
      if (selector.includes('autocomplete="current-password"')) {
        return locator({
          isVisible: currentPasswordVisible,
          onFill: onCurrentPasswordFill,
        });
      }
      return locator();
    },
    getByRole(role, options = {}) {
      return locator({
        isVisible:
          (role === "button"
            && options.name instanceof RegExp
            && options.name.test("Continue"))
          || (role === "heading"
            && heading !== null
            && options.name instanceof RegExp
            && options.name.test(heading)),
        onClick: onSemanticSubmit,
      });
    },
    async waitForTimeout() {
      onWait?.();
    },
  };
}

function fakeFixtureIdentityPage({ visibleTicks, onWait } = {}) {
  let remainingVisibleTicks = visibleTicks;
  const page = {
    clicks: 0,
    waits: 0,
    getByLabel() {
      return {
        first() {
          return this;
        },
        async isVisible() {
          return remainingVisibleTicks > 0;
        },
        async fill(value) {
          assert.equal(value, "synthetic-current");
        },
      };
    },
    getByRole() {
      return {
        async click() {
          page.clicks += 1;
        },
      };
    },
    async waitForTimeout() {
      page.waits += 1;
      remainingVisibleTicks -= 1;
      onWait?.();
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
