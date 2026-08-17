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

test("changes authenticator 2FA and verifies the new enrollment", async () => {
  const page = createFixturePage(["login_ready", "signed_in"]);
  const events = [];
  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: { ...request(), operation: "change_totp", new_password: "" },
    emit: (message) => events.push(message),
    control: {
      throwIfCancelled() {},
      async waitFor(type) {
        assert.equal(type, "totp_enrollment_code");
        return { type, request_id: "req_1", code: "123456" };
      },
    },
  });
  assert.deepEqual(page.actions.map((action) => action.type), [
    "open_login", "submit_credentials", "open_totp_change",
    "read_totp_enrollment", "submit_totp_enrollment", "verify_totp_changed",
  ]);
  assert.equal(events.some((event) => event.type === "totp_enrollment_secret"), true);
  assert.equal(events.at(-1).type, "verified");
});

test("changes email with connector code and verifies the new address", async () => {
  const page = createFixturePage(["login_ready", "signed_in"]);
  const events = [];
  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: {
      ...request(),
      operation: "change_email",
      new_password: "",
      new_email: "synthetic-new@example.test",
    },
    emit: (message) => events.push(message),
    control: {
      throwIfCancelled() {},
      async waitForAny(types) {
        assert.deepEqual(types, ["email_verification_code", "resume"]);
        return { type: "email_verification_code", request_id: "req_1", code: "654321" };
      },
    },
  });
  assert.deepEqual(page.actions.map((action) => action.type), [
    "open_login", "submit_credentials", "open_email_change",
    "submit_email_change", "submit_email_verification", "verify_email_changed",
  ]);
  assert.equal(events.some((event) => event.type === "email_verification_required"), true);
  assert.equal(events.at(-1).type, "verified");
});

test("continues login when the email step has not submitted the password", async () => {
  const page = createFixturePage([
    "login_ready",
    "flow_changed",
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);
  const baseAdapter = getAdapter("fixture-v1");
  let loginSubmissions = 0;
  const adapter = {
    ...baseAdapter,
    async submitCredentials(...args) {
      loginSubmissions += 1;
      await baseAdapter.submitCredentials(...args);
      return loginSubmissions === 1 ? false : true;
    },
  };
  const events = [];

  await runAccountFlow({
    page,
    adapter,
    request: request(),
    emit: (message) => events.push(message),
    control: {
      throwIfCancelled() {},
      async waitFor(expectedType) {
        if (expectedType === "submit_password") {
          return {
            protocol_version: 1,
            type: "submit_password",
            request_id: "req_1",
          };
        }
        throw Object.assign(new Error("protocol_error"), { code: "protocol_error" });
      },
    },
  });

  assert.equal(events.at(-1).type, "verified");
  assert.equal(loginSubmissions, 3);
});

test("waits through a transient state after submitting the login password", async () => {
  const { events } = await execute([
    "login_ready",
    "flow_changed",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);

  assert.equal(events.at(-1).type, "verified");
});

test("waits while the login form remains visible after password submit", async () => {
  const { events } = await execute([
    "login_ready",
    "login_ready",
    "login_ready",
    "signed_in",
    "password_change_ready",
    "password_changed",
    "login_ready",
    "signed_in",
  ]);

  assert.equal(events.at(-1).type, "verified");
});

test("verifies recovery credentials without changing the password", async () => {
  const page = createFixturePage([
    "signed_in",
    "login_ready",
    "signed_in",
  ]);
  const events = [];

  await runAccountFlow({
    page,
    adapter: getAdapter("fixture-v1"),
    request: { ...request(), operation: "verify_credentials" },
    emit: (message) => events.push(message),
    control: {
      throwIfCancelled() {},
      async waitFor() {
        throw Object.assign(new Error("protocol_error"), { code: "protocol_error" });
      },
    },
  });

  assert.equal(events.at(-1).type, "verified");
  assert.equal(events.some((event) => event.type === "password_changed"), false);
  assert.deepEqual(
    page.actions.map((action) => action.type),
    [
      "open_login",
      "logout",
      "open_login",
      "submit_credentials",
      "verify_signed_in",
    ],
  );
});

test("adopts the auth page returned by credential preparation", async () => {
  const expiredPage = { url: () => "https://chatgpt.com/" };
  const authPage = { url: () => "https://auth.openai.com/log-in/password" };
  let currentPage = expiredPage;
  const states = ["login_ready", "signed_in"];
  const events = [];
  const pageSession = {
    async current() {
      return currentPage;
    },
    adopt(page) {
      currentPage = page;
    },
  };
  const adapter = {
    async prepareCredentialVerification(page) {
      assert.equal(page, expiredPage);
      return authPage;
    },
    async classify(page) {
      assert.equal(page, authPage);
      return states.shift();
    },
    async submitCredentials(page) {
      assert.equal(page, authPage);
      return true;
    },
    async verifySignedIn(page) {
      assert.equal(page, authPage);
      return true;
    },
  };

  await runAccountFlow({
    pageSession,
    adapter,
    request: { ...request(), operation: "verify_credentials" },
    emit: (message) => events.push(message),
    control: {
      throwIfCancelled() {},
      async waitFor() {
        throw Object.assign(new Error("protocol_error"), { code: "protocol_error" });
      },
    },
  });

  assert.equal(events.at(-1).type, "verified");
  assert.equal(currentPage, authPage);
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

test("waits through a transient verification state after submitting TOTP", async () => {
  const { page, events } = await execute(
    [
      "login_ready",
      "signed_in",
      "password_change_ready",
      "password_changed",
      "login_ready",
      "totp_required",
      "flow_changed",
      "signed_in",
    ],
    [{ type: "totp_code", code: "654321" }],
  );

  assert.equal(events.at(-1).type, "verified");
  assert.deepEqual(
    page.actions.filter((action) => action.type === "submit_totp").map((action) => action.code),
    ["654321"],
  );
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

test("OpenAI adapter does not treat the guest composer shell as signed in", async () => {
  const locator = (isVisible) => ({
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
    nth() {
      return this;
    },
  });
  const page = {
    url: () => "https://chatgpt.com/",
    locator(selector) {
      return locator(
        selector.includes('data-testid="login-button"')
        || selector.includes("#prompt-textarea"),
      );
    },
    getByRole() {
      return locator(false);
    },
  };

  assert.equal(await openaiChatgptAdapter.classify(page), "flow_changed");
});

test("OpenAI openLogin preserves an existing signed-in session", async () => {
  const page = fakeOpenAiPage({
    url: "https://chatgpt.com/",
    visible: [{ role: "button", label: "Profile menu" }],
  });
  page.goto = async () => {
    throw new Error("must not navigate away from the signed-in session");
  };

  await openaiChatgptAdapter.openLogin(page);
});

test("OpenAI openLogin probes the app session before forcing direct login", async () => {
  let currentUrl = "about:blank";
  const navigations = [];
  const page = fakeOpenAiPage({
    url: currentUrl,
    visible: [{ role: "button", label: "Profile menu" }],
  });
  page.url = () => currentUrl;
  page.goto = async (url) => {
    navigations.push(url);
    currentUrl = url;
  };

  await openaiChatgptAdapter.openLogin(page);

  assert.deepEqual(navigations, ["https://chatgpt.com/"]);
});

test("OpenAI openLogin waits for a delayed password form mount", async () => {
  let stage = "initial";
  let waits = 0;
  const locator = ({ visible = false } = {}) => ({
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return typeof visible === "function" ? visible() : visible;
    },
  });
  const page = {
    url: () => stage === "initial"
      ? "about:blank"
      : "https://auth.openai.com/log-in/password",
    async goto() {
      stage = "loading";
    },
    locator(selector) {
      return locator({
        visible: () =>
          selector.includes('autocomplete="current-password"')
          && stage === "password",
      });
    },
    getByRole() {
      return locator();
    },
    async waitForTimeout() {
      waits += 1;
      stage = "password";
    },
  };

  await openaiChatgptAdapter.openLogin(page);

  assert.equal(stage, "password");
  assert.equal(waits, 1);
});

test("OpenAI adapter closes stale auth tabs before a new worker flow", async () => {
  const closed = [];
  const page = (url) => ({
    url: () => url,
    async close() {
      closed.push(url);
    },
  });
  const signedIn = page("https://chatgpt.com/");
  const context = {
    pages: () => [
      page("https://auth.openai.com/log-in/password"),
      page("https://chatgpt.com/auth/login"),
      signedIn,
      page("https://example.com/"),
    ],
  };

  await openaiChatgptAdapter.prepareContext(context);

  assert.deepEqual(closed, [
    "https://auth.openai.com/log-in/password",
    "https://chatgpt.com/auth/login",
  ]);
  assert.equal(context.pages().includes(signedIn), true);
});

test("OpenAI openLogin resumes from an expired-session dialog", async () => {
  let stage = "expired";
  const actions = [];
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
    getByRole(role, options = {}) {
      if (
        role === "button"
        && options.name instanceof RegExp
        && options.name.test("Log in")
      ) {
        return locator({
          visible: () => stage === "expired",
          onClick: () => {
            actions.push("login");
            stage = "transition";
          },
        });
      }
      return locator({ visible: () => false });
    },
    locator() {
      return locator({ visible: () => false });
    },
  });
  const page = {
    url: () => "https://chatgpt.com/",
    async goto() {
      throw new Error("must use the expired-session login action");
    },
    locator(selector) {
      if (selector.includes("modal-expired-session")) {
        return locator({ visible: () => stage === "expired" || stage === "transition" });
      }
      if (selector.includes('autocomplete="username"')) {
        return locator({ visible: () => stage === "email" });
      }
      return locator({ visible: () => false });
    },
    getByRole(role, options = {}) {
      if (role === "dialog") {
        return locator({ visible: () => stage === "expired" });
      }
      if (
        role === "button"
        && options.name instanceof RegExp
        && options.name.test("Profile menu")
      ) {
        return locator({ visible: () => stage === "expired" });
      }
      return locator({ visible: () => false });
    },
    async waitForTimeout() {
      if (stage === "transition") {
        stage = "email";
      }
    },
  };

  assert.equal(await openaiChatgptAdapter.classify(page), "flow_changed");
  await openaiChatgptAdapter.openLogin(page);

  assert.deepEqual(actions, ["login"]);
  assert.equal(stage, "email");
});

test("OpenAI adapter treats a post-login billing interstitial as signed in", async () => {
  const page = fakeOpenAiPage({
    url: "https://chatgpt.com/",
    visible: [{ role: "dialog", label: "Xem lại phương thức thanh toán" }],
  });
  assert.equal(await openaiChatgptAdapter.classify(page), "signed_in");
});

test("OpenAI logout dismisses a blocking interstitial before opening the menu", async () => {
  const events = [];
  let dialogVisible = true;
  let menuOpen = false;
  const hiddenDialog = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return false;
    },
    getByRole() {
      return this;
    },
    locator() {
      return this;
    },
  };
  const dialogButton = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return dialogVisible;
    },
    getByRole() {
      return dialogButton;
    },
    locator() {
      return dialogButton;
    },
    async click() {
      events.push("dismiss");
      dialogVisible = false;
    },
  };
  const menuButton = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return !dialogVisible;
    },
    async click() {
      events.push("menu");
      menuOpen = true;
    },
  };
  const logoutItem = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return menuOpen;
    },
    async click() {
      events.push("logout");
    },
  };
  const page = {
    url: () => "https://chatgpt.com/",
    keyboard: { async press() { events.push("escape"); } },
    async waitForTimeout() {},
    locator() {
      return { first() { return this; }, filter() { return this; }, async isVisible() { return false; }, async count() { return 0; } };
    },
    getByRole(role, options = {}) {
      if (role === "dialog") return dialogButton;
      if (role === "button" && options.name instanceof RegExp && options.name.test("Profile menu")) {
        return menuButton;
      }
      if ((role === "menuitem" || role === "button") && options.name instanceof RegExp && options.name.test("Log out")) {
        return logoutItem;
      }
      return { first() { return this; }, filter() { return this; }, async isVisible() { return false; } };
    },
  };

  await openaiChatgptAdapter.logout(page);

  assert.deepEqual(events, ["dismiss", "menu", "logout"]);
});

test("OpenAI logout force-clicks the profile menu when its avatar intercepts clicks", async () => {
  const events = [];
  let menuOpen = false;
  const hidden = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return false;
    },
    async count() {
      return 0;
    },
  };
  const menuButton = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return true;
    },
    async click(options) {
      if (options?.force !== true) {
        throw new Error("avatar intercepts pointer events");
      }
      events.push("menu");
      menuOpen = true;
    },
  };
  const logoutItem = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return menuOpen;
    },
    async click() {
      events.push("logout");
    },
  };
  const page = {
    url: () => "https://chatgpt.com/",
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) {
        return menuButton;
      }
      return hidden;
    },
    getByRole(role, options = {}) {
      if (role === "button" && options.name instanceof RegExp && options.name.test("Open profile menu")) {
        return menuButton;
      }
      if ((role === "menuitem" || role === "button") && options.name instanceof RegExp && options.name.test("Log out")) {
        return logoutItem;
      }
      return hidden;
    },
  };

  await openaiChatgptAdapter.logout(page);

  assert.deepEqual(events, ["menu", "logout"]);
});

test("OpenAI logout uses an already-open account menu with duplicate profile buttons", async () => {
  const events = [];
  let menuOpen = true;
  const hidden = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return false;
    },
    async count() {
      return 0;
    },
  };
  const profileButtons = {
    first() {
      return this.nth(0);
    },
    filter() {
      return this;
    },
    async count() {
      return 2;
    },
    nth(index) {
      return {
        first() {
          return this;
        },
        async isVisible() {
          return index === 1;
        },
        async click() {
          events.push(`profile-${index}`);
          menuOpen = !menuOpen;
        },
      };
    },
  };
  const logoutItem = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return menuOpen;
    },
    async click() {
      events.push("logout");
      menuOpen = false;
    },
  };
  const page = {
    url: () => "https://chatgpt.com/",
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) {
        return profileButtons;
      }
      if (selector.includes('data-testid="log-out-menu-item"')) {
        return logoutItem;
      }
      return hidden;
    },
    getByRole(role, options = {}) {
      if ((role === "menuitem" || role === "button") && options.name instanceof RegExp && options.name.test("Log out")) {
        return logoutItem;
      }
      return hidden;
    },
  };

  await openaiChatgptAdapter.logout(page);

  assert.deepEqual(events, ["logout"]);
});

test("OpenAI logout waits for the delayed logout menu item", async () => {
  const events = [];
  let menuOpen = false;
  let waitTicks = 0;
  const hidden = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return false;
    },
    async count() {
      return 0;
    },
  };
  const menuButton = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return true;
    },
    async click(options) {
      assert.equal(options?.force, true);
      menuOpen = true;
      events.push("menu");
    },
  };
  const logoutItem = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return menuOpen && waitTicks >= 2;
    },
    async click() {
      events.push("logout");
    },
  };
  const page = {
    url: () => "https://chatgpt.com/",
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) {
        return menuButton;
      }
      if (selector.includes('data-testid="log-out-menu-item"')) {
        return logoutItem;
      }
      return hidden;
    },
    getByRole(role, options = {}) {
      if (role === "button" && options.name instanceof RegExp && options.name.test("Open profile menu")) {
        return menuButton;
      }
      if ((role === "menuitem" || role === "button") && options.name instanceof RegExp && options.name.test("Log out")) {
        return logoutItem;
      }
      return hidden;
    },
    async waitForTimeout() {
      waitTicks += 1;
    },
  };

  await openaiChatgptAdapter.logout(page);

  assert.deepEqual(events, ["menu", "logout"]);
});

test("OpenAI logout waits until a signed-out surface replaces the stale shell", async () => {
  let menuOpen = false;
  let logoutClicked = false;
  let waitTicks = 0;
  const hidden = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    async isVisible() {
      return false;
    },
    async count() {
      return 0;
    },
  };
  const profileButton = {
    ...hidden,
    async isVisible() {
      return !logoutClicked || waitTicks < 2;
    },
    async click() {
      menuOpen = true;
    },
  };
  const logoutItem = {
    ...hidden,
    async isVisible() {
      return menuOpen;
    },
    async click() {
      logoutClicked = true;
    },
  };
  const loginButton = {
    ...hidden,
    async isVisible() {
      return logoutClicked && waitTicks >= 2;
    },
  };
  const page = {
    url: () => "https://chatgpt.com/",
    context() {
      return { pages: () => [page] };
    },
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) {
        return profileButton;
      }
      if (selector.includes('data-testid="log-out-menu-item"')) {
        return logoutItem;
      }
      if (selector.includes('data-testid="login-button"')) {
        return loginButton;
      }
      return hidden;
    },
    getByRole(role, options = {}) {
      if (role === "button" && options.name instanceof RegExp && options.name.test("Open profile menu")) {
        return profileButton;
      }
      if ((role === "menuitem" || role === "button") && options.name instanceof RegExp && options.name.test("Log out")) {
        return logoutItem;
      }
      if ((role === "button" || role === "link") && options.name instanceof RegExp && options.name.test("Log in")) {
        return loginButton;
      }
      return hidden;
    },
    async waitForTimeout() {
      waitTicks += 1;
    },
  };

  await openaiChatgptAdapter.logout(page);

  assert.equal(logoutClicked, true);
  assert.equal(waitTicks, 2);
});

test("OpenAI logout confirms a logout dialog before waiting for sign-out", async () => {
  const events = [];
  let menuOpen = false;
  let dialogOpen = false;
  let dialogConfirmed = false;
  const hidden = {
    first() {
      return this;
    },
    filter() {
      return this;
    },
    getByRole() {
      return hidden;
    },
    async isVisible() {
      return false;
    },
    async count() {
      return 0;
    },
  };
  const profileButton = {
    ...hidden,
    async isVisible() {
      return !dialogConfirmed;
    },
    async click() {
      menuOpen = true;
    },
  };
  const logoutItem = {
    ...hidden,
    async isVisible() {
      return menuOpen;
    },
    async click() {
      events.push("menu-logout");
      dialogOpen = true;
    },
  };
  const confirmButton = {
    ...hidden,
    async isVisible() {
      return dialogOpen;
    },
    async click() {
      events.push("confirm");
      dialogConfirmed = true;
    },
  };
  const logoutDialog = {
    ...hidden,
    filter() {
      return logoutDialog;
    },
    getByRole(role, options = {}) {
      if (
        role === "button"
        && options.name instanceof RegExp
        && options.name.test("Đăng xuất")
      ) {
        return confirmButton;
      }
      return hidden;
    },
  };
  const loginButton = {
    ...hidden,
    async isVisible() {
      return dialogConfirmed;
    },
  };
  const page = {
    url: () => "https://chatgpt.com/",
    context() {
      return { pages: () => [page] };
    },
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) {
        return profileButton;
      }
      if (selector.includes('data-testid="log-out-menu-item"')) {
        return logoutItem;
      }
      if (selector.includes('data-testid="login-button"')) {
        return loginButton;
      }
      return hidden;
    },
    getByRole(role, options = {}) {
      if (role === "dialog" || role === "alertdialog") {
        return logoutDialog;
      }
      if (
        role === "button"
        && options.name instanceof RegExp
        && options.name.test("Open profile menu")
      ) {
        return profileButton;
      }
      if (
        (role === "menuitem" || role === "button")
        && options.name instanceof RegExp
        && options.name.test("Đăng xuất")
      ) {
        return logoutItem;
      }
      if (
        (role === "button" || role === "link")
        && options.name instanceof RegExp
        && options.name.test("Đăng nhập")
      ) {
        return loginButton;
      }
      return hidden;
    },
    async waitForTimeout() {},
  };

  await openaiChatgptAdapter.logout(page);

  assert.deepEqual(events, ["menu-logout", "confirm"]);
  assert.equal(dialogConfirmed, true);
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

test("OpenAI adapter prefers a visible TOTP input over a generic verify heading", async () => {
  const page = fakeOpenAiFormPage({
    totpVisible: true,
    heading: "Verify your identity",
  });

  assert.equal(await openaiChatgptAdapter.classify(page), "totp_required");
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

test("OpenAI adapter waits for the new-password form to leave after submit", async () => {
  let passwordVisibleTicks = 3;
  let submitClicks = 0;
  let waitTicks = 0;
  const passwordInput = {
    first() {
      return this;
    },
    async isVisible() {
      return passwordVisibleTicks > 0;
    },
    async fill(value) {
      assert.equal(value, "synthetic-new-password");
    },
  };
  const passwordInputs = {
    first() {
      return passwordInput;
    },
    async count() {
      return 2;
    },
    nth() {
      return passwordInput;
    },
  };
  const submit = {
    first() {
      return this;
    },
    async isVisible() {
      return passwordVisibleTicks > 0;
    },
    async click() {
      submitClicks += 1;
    },
  };
  const hidden = {
    first() {
      return this;
    },
    async isVisible() {
      return false;
    },
  };
  const page = {
    locator(selector) {
      if (selector === 'input[autocomplete="new-password"]') {
        return passwordInputs;
      }
      if (selector === 'button[type="submit"], input[type="submit"]') {
        return submit;
      }
      return hidden;
    },
    getByRole() {
      return hidden;
    },
    async waitForTimeout() {
      waitTicks += 1;
      passwordVisibleTicks -= 1;
    },
  };

  await openaiChatgptAdapter.submitPasswordChange(
    page,
    { newPassword: "synthetic-new-password" },
  );

  assert.equal(submitClicks, 1);
  assert.equal(passwordVisibleTicks <= 0, true);
  assert.equal(waitTicks, 4);
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

test("OpenAI adapter submits Vietnamese login forms without a submit type", async () => {
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
        // ChatGPT's email step swaps the email field out for the next surface
        // once Continue is clicked; model that so submitCredentials' settle
        // (waitUntilHidden) can observe the transition instead of timing out.
        return locator({
          dynamicVisible: () => submitClicks === 0,
          onFill: (value) => assert.equal(value, "synthetic@example.test"),
        });
      }
      if (selector === 'button[type="submit"], input[type="submit"]') {
        return locator();
      }
      if (selector.includes('autocomplete="one-time-code"')) {
        return locator({ dynamicVisible: () => totpVisible });
      }
      return locator();
    },
    getByRole(_role, options = {}) {
      return locator({
        visible: options.name instanceof RegExp && options.name.test("Tiếp tục"),
        onClick: () => {
          submitClicks += 1;
          totpVisible = true;
        },
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

test("OpenAI adapter does not wait for provider navigation when submitting TOTP", async () => {
  let clickOptions = null;
  const locator = ({ visible = false, onFill } = {}) => ({
    first() {
      return this;
    },
    async isVisible() {
      return visible;
    },
    async fill(value) {
      onFill?.(value);
    },
    async click(options) {
      clickOptions = options;
    },
  });
  const page = {
    locator(selector) {
      if (selector.includes('autocomplete="one-time-code"')) {
        return locator({
          visible: true,
          onFill: (value) => assert.equal(value, "123456"),
        });
      }
      if (selector === 'button[type="submit"], input[type="submit"]') {
        return locator({ visible: true });
      }
      return locator();
    },
    getByRole() {
      return locator();
    },
  };

  await openaiChatgptAdapter.submitTotp(page, "123456");

  assert.deepEqual(clickOptions, { noWaitAfter: true });
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

test("OpenAI adapter clicks the visible submit control for the login password", async () => {
  let passwordVisible = true;
  let pressed = null;
  let buttonClicks = 0;
  let buttonClickOptions = null;
  const locator = ({ visible = false, onClick, onFill, onPress } = {}) => ({
    first() {
      return this;
    },
    async isVisible() {
      return typeof visible === "function" ? visible() : visible;
    },
    async click(options) {
      buttonClicks += 1;
      buttonClickOptions = options;
      onClick?.();
    },
    async fill(value) {
      onFill?.(value);
    },
    async press(key, options) {
      pressed = { key, options };
      onPress?.();
    },
  });
  const page = {
    locator(selector) {
      if (selector.includes('autocomplete="current-password"')) {
        return locator({
          visible: () => passwordVisible,
          onFill: (value) => assert.equal(value, "synthetic"),
          onPress: () => {
            passwordVisible = false;
          },
        });
      }
      if (selector === 'button[type="submit"], input[type="submit"]') {
        return locator({
          visible: true,
          onClick: () => {
            passwordVisible = false;
          },
        });
      }
      return locator();
    },
    getByRole() {
      return locator();
    },
    async waitForTimeout() {},
  };

  await openaiChatgptAdapter.submitCredentials(page, {
    account: "synthetic@example.test",
    password: "synthetic",
  });

  assert.equal(pressed, null);
  assert.equal(buttonClicks, 1);
  assert.deepEqual(buttonClickOptions, { noWaitAfter: true });
});
test("OpenAI adapter does not wait for provider navigation when submitting login", async () => {
  let clickOptions = null;
  const locator = ({ visible = false, onClick, onFill } = {}) => ({
    first() {
      return this;
    },
    async isVisible() {
      return visible;
    },
    async click(options) {
      clickOptions = options;
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
          visible: true,
          onFill: (value) => assert.equal(value, "synthetic"),
        });
      }
      if (selector === 'button[type="submit"], input[type="submit"]') {
        return locator({ visible: true });
      }
      return locator();
    },
    getByRole() {
      return locator();
    },
    async waitForTimeout() {},
  };

  await openaiChatgptAdapter.submitCredentials(page, {
    account: "synthetic@example.test",
    password: "synthetic",
  });

  assert.deepEqual(clickOptions, { noWaitAfter: true });
});
test("OpenAI adapter opens the signed-in password setting without logging out", async () => {
  let stage = "signed_in";
  const actions = [];
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
    async count() {
      return 0;
    },
    async click(options) {
      onClick?.(options);
    },
  });
  const hidden = () => locator({ visible: () => false });
  const page = {
    url: () => stage === "identity"
      ? "https://auth.openai.com/log-in/password"
      : "https://chatgpt.com/",
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) {
        return locator({
          visible: () => stage === "signed_in",
          onClick: (options) => {
            assert.equal(options?.force, true);
            actions.push("profile");
            stage = "profile_menu";
          },
        });
      }
      if (selector.includes('data-testid="settings-menu-item"')) {
        return locator({
          visible: () => stage === "profile_menu",
          onClick: () => {
            actions.push("settings");
            stage = "settings";
          },
        });
      }
      if (selector.includes('data-testid="modal-settings"')) {
        return locator({ visible: () => stage === "settings" || stage === "security" });
      }
      if (selector.includes('data-testid="security-tab"')) {
        return locator({
          visible: () => stage === "settings",
          onClick: () => {
            actions.push("security");
            stage = "security";
          },
        });
      }
      if (selector.includes('data-testid="password-setting"')) {
        return locator({
          visible: () => stage === "security",
          onClick: () => {
            actions.push("password");
            stage = "password_transition";
          },
        });
      }
      if (selector.includes('autocomplete="current-password"')) {
        return locator({ visible: () => stage === "identity" });
      }
      return hidden();
    },
    getByRole(role, options = {}) {
      if (
        role === "button"
        && options.name instanceof RegExp
        && options.name.test("Open profile menu")
      ) {
        return this.locator('[data-testid="accounts-profile-button"]');
      }
      if (role === "alert") {
        return locator({ visible: () => stage === "password_transition" });
      }
      return hidden();
    },
    async waitForTimeout() {
      if (stage !== "password_transition") {
        throw new Error("unexpected transition wait");
      }
      stage = "identity";
    },
  };

  await openaiChatgptAdapter.openPasswordChange(page, {
    account: "synthetic@example.test",
  });

  assert.deepEqual(actions, ["profile", "settings", "security", "password"]);
  assert.equal(page.url(), "https://auth.openai.com/log-in/password");
});

test("OpenAI password change uses an already-open account menu", async () => {
  let stage = "profile_menu";
  const actions = [];
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
    async count() {
      return 0;
    },
    async click(options) {
      onClick?.(options);
    },
  });
  const hidden = () => locator({ visible: () => false });
  const profileButton = locator({
    visible: () => stage === "profile_menu",
    onClick: () => {
      actions.push("profile");
      stage = "signed_in";
    },
  });
  const page = {
    url: () => stage === "identity"
      ? "https://auth.openai.com/log-in/password"
      : "https://chatgpt.com/",
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) {
        return profileButton;
      }
      if (selector.includes('data-testid="settings-menu-item"')) {
        return locator({
          visible: () => stage === "profile_menu",
          onClick: () => {
            actions.push("settings");
            stage = "settings";
          },
        });
      }
      if (selector.includes('data-testid="modal-settings"')) {
        return locator({ visible: () => stage === "settings" || stage === "security" });
      }
      if (selector.includes('data-testid="security-tab"')) {
        return locator({
          visible: () => stage === "settings",
          onClick: () => {
            actions.push("security");
            stage = "security";
          },
        });
      }
      if (selector.includes('data-testid="password-setting"')) {
        return locator({
          visible: () => stage === "security",
          onClick: () => {
            actions.push("password");
            stage = "identity";
          },
        });
      }
      if (selector.includes('autocomplete="current-password"')) {
        return locator({ visible: () => stage === "identity" });
      }
      return hidden();
    },
    getByRole(role, options = {}) {
      if (
        role === "button"
        && options.name instanceof RegExp
        && options.name.test("Open profile menu")
      ) {
        return profileButton;
      }
      return hidden();
    },
    async waitForTimeout() {},
  };

  await openaiChatgptAdapter.openPasswordChange(page);

  assert.deepEqual(actions, ["settings", "security", "password"]);
});

test("OpenAI adapter changes TOTP through explicit security settings", async () => {
  let stage = "profile_menu";
  const actions = [];
  let submittedCode = null;
  const locator = ({ visible = () => false, onClick, value = "", text = "", onFill } = {}) => ({
    first() { return this; },
    filter() { return this; },
    async isVisible() { return Boolean(visible()); },
    async count() { return 0; },
    async click(options) { onClick?.(options); },
    async fill(next) { onFill?.(next); },
    async inputValue() { return value; },
    async textContent() { return text; },
  });
  const hidden = () => locator();
  const page = {
    url: () => "https://chatgpt.com/",
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) {
        return locator({ visible: () => stage === "profile_menu" });
      }
      if (selector.includes('data-testid="settings-menu-item"')) {
        return locator({ visible: () => stage === "profile_menu", onClick: () => { actions.push("settings"); stage = "settings"; } });
      }
      if (selector.includes('data-testid="security-tab"')) {
        return locator({ visible: () => stage === "settings", onClick: () => { actions.push("security"); stage = "security"; } });
      }
      if (selector.includes('data-testid="mfa-setting"')) {
        return locator({ visible: () => stage === "security", onClick: () => { actions.push("mfa"); stage = "enrollment"; } });
      }
      if (selector.includes('data-testid="totp-secret"')) {
        return locator({ visible: () => stage === "enrollment", value: "JBSW Y3DP EHPK 3PXP" });
      }
      if (selector.includes('autocomplete="one-time-code"')) {
        return locator({ visible: () => stage === "enrollment", onFill: (code) => { submittedCode = code; } });
      }
      if (selector.includes('button[type="submit"]')) {
        return locator({ visible: () => stage === "enrollment", onClick: () => { stage = "enabled"; } });
      }
      return hidden();
    },
    getByRole(role) {
      if (role === "button" && stage === "enabled") return locator({ visible: () => true });
      return hidden();
    },
    getByText() { return hidden(); },
    async waitForTimeout() {},
  };

  await openaiChatgptAdapter.openTotpChange(page);
  assert.equal(await openaiChatgptAdapter.readTotpEnrollment(page), "JBSWY3DPEHPK3PXP");
  await openaiChatgptAdapter.submitTotpEnrollment(page, "123456");
  assert.equal(submittedCode, "123456");
  assert.equal(await openaiChatgptAdapter.verifyTotpChanged(page), true);
  assert.deepEqual(actions, ["settings", "security", "mfa"]);
});

test("OpenAI adapter changes email through explicit account settings", async () => {
  let stage = "profile_menu";
  const actions = [];
  let enteredEmail = null;
  let enteredCode = null;
  const locator = ({ visible = () => false, onClick, onFill } = {}) => ({
    first() { return this; },
    filter() { return this; },
    async isVisible() { return Boolean(visible()); },
    async count() { return 0; },
    async click(options) { onClick?.(options); },
    async fill(value) { onFill?.(value); },
  });
  const hidden = () => locator();
  const page = {
    url: () => "https://chatgpt.com/",
    locator(selector) {
      if (selector.includes('data-testid="accounts-profile-button"')) return locator({ visible: () => stage === "profile_menu" });
      if (selector.includes('data-testid="settings-menu-item"')) return locator({ visible: () => stage === "profile_menu", onClick: () => { actions.push("settings"); stage = "settings"; } });
      if (selector.includes('data-testid="account-tab"')) return locator({ visible: () => stage === "settings", onClick: () => { actions.push("account"); stage = "account"; } });
      if (selector.includes('data-testid="email-setting"')) return locator({ visible: () => stage === "account", onClick: () => { actions.push("email"); stage = "email_form"; } });
      if (selector.includes('autocomplete="username"')) return locator({ visible: () => stage === "email_form", onFill: (value) => { enteredEmail = value; } });
      if (selector.includes('autocomplete="one-time-code"')) return locator({ visible: () => stage === "verification", onFill: (value) => { enteredCode = value; } });
      if (selector.includes('button[type="submit"]')) return locator({ visible: () => stage === "email_form" || stage === "verification", onClick: () => { stage = stage === "email_form" ? "verification" : "changed"; } });
      return hidden();
    },
    getByRole() { return hidden(); },
    getByText(text) { return locator({ visible: () => stage === "changed" && text === "new@example.test" }); },
    async waitForTimeout() {},
  };

  await openaiChatgptAdapter.openEmailChange(page);
  await openaiChatgptAdapter.submitEmailChange(page, "new@example.test");
  await openaiChatgptAdapter.submitEmailVerification(page, "654321");
  assert.equal(await openaiChatgptAdapter.verifyEmailChanged(page, "new@example.test"), true);
  assert.equal(enteredEmail, "new@example.test");
  assert.equal(enteredCode, "654321");
  assert.deepEqual(actions, ["settings", "account", "email"]);
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
  totpVisible = false,
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
      if (selector.includes('autocomplete="one-time-code"')) {
        return locator({ isVisible: totpVisible });
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
