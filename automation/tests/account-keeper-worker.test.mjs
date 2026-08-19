import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  CommandControl,
  createControlledPageSession,
  validateCdpEndpoint,
  validateCodexOAuthUrl,
} from "../account-keeper-worker-runtime.mjs";
import * as protocol from "../account-keeper-protocol.mjs";

test("accepts only exact loopback HTTP CDP endpoints", () => {
  assert.equal(validateCdpEndpoint("http://127.0.0.1:9222"), "http://127.0.0.1:9222/");
  for (const endpoint of [
    "http://localhost:9222",
    "http://127.0.0.1:0",
    "https://127.0.0.1:9222",
    "http://127.0.0.1:9222/path",
    "http://127.0.0.1:9222/?token=x",
  ]) {
    assert.throws(() => validateCdpEndpoint(endpoint), /protocol_error/);
  }
});

test("accepts only exact Codex OAuth authorization URLs", () => {
  const valid = "https://auth.openai.com/oauth/authorize?client_id=synthetic&state=synthetic";
  assert.equal(validateCodexOAuthUrl(valid), valid);
  for (const value of [
    "https://example.test/oauth/authorize?client_id=x&state=y",
    "http://auth.openai.com/oauth/authorize?client_id=x&state=y",
    "https://auth.openai.com/other?client_id=x&state=y",
  ]) assert.throws(() => validateCodexOAuthUrl(value), /protocol_error/);
});

test("command control rejects early and duplicate phase commands", async () => {
  const control = new CommandControl("req_1");
  assert.equal(control.push({ request_id: "req_1", type: "resume" }), false);

  const first = control.waitFor("totp_code");
  assert.equal(control.push({ request_id: "req_1", type: "totp_code", code: "123456" }), true);
  assert.equal((await first).code, "123456");
  assert.equal(control.push({ request_id: "req_1", type: "totp_code", code: "654321" }), false);

  const manual = control.waitFor("resume");
  assert.equal(control.push({ request_id: "req_1", type: "resume" }), true);
  assert.equal((await manual).type, "resume");
});

test("cancellation has priority over expected commands", async () => {
  const control = new CommandControl("req_1");
  const waiting = control.waitFor("totp_code");
  assert.equal(control.push({ request_id: "req_1", type: "cancel" }), true);
  assert.equal((await waiting).type, "cancel");
  assert.throws(() => control.throwIfCancelled(), /cancelled/);
});

test("command control accepts email code or manual resume", async () => {
  const control = new CommandControl("req_1");
  const waiting = control.waitForAny(["email_verification_code", "resume"]);
  assert.equal(control.push({
    request_id: "req_1",
    type: "email_verification_code",
    code: "123456",
  }), true);
  assert.equal((await waiting).code, "123456");
});

test("extends worker control with explicit password submit authorization", async () => {
  assert.equal(typeof protocol.withPasswordSubmitAuthorization, "function");
  const control = protocol.withPasswordSubmitAuthorization(
    new CommandControl("req_1"),
  );
  const waiting = control.waitFor("submit_password");
  assert.equal(control.push({ request_id: "req_1", type: "resume" }), false);
  assert.equal(
    control.push({ request_id: "req_1", type: "submit_password" }),
    true,
  );
  assert.equal((await waiting).type, "submit_password");
});

test("extends worker control with explicit TOTP disable authorization", async () => {
  const control = protocol.withPasswordSubmitAuthorization(
    new CommandControl("req_1"),
  );
  const waiting = control.waitFor("submit_totp_disable");
  assert.equal(
    control.push({ request_id: "req_1", type: "submit_totp_disable" }),
    true,
  );
  assert.equal((await waiting).type, "submit_totp_disable");
});

test("password authorization wrapper preserves multi-command waits", async () => {
  const control = protocol.withPasswordSubmitAuthorization(
    new CommandControl("req_1"),
  );
  const waiting = control.waitForAny(["email_verification_code", "resume"]);
  assert.equal(control.push({ request_id: "req_1", type: "resume" }), true);
  assert.equal((await waiting).type, "resume");
});

test("creates dedicated page and switches to allowed-origin popup", async () => {
  const existing = new FakePage("https://chatgpt.com/existing");
  const context = new FakeContext([existing]);
  const session = await createControlledPageSession(context, [
    "https://chatgpt.com",
    "https://auth.openai.com",
  ]);
  const dedicated = await session.current();
  assert.notEqual(dedicated, existing);
  assert.equal(context.created, 1);

  const popup = new FakePage("about:blank");
  context.emit("page", popup);
  popup.navigate("https://evil.example/reset");
  assert.equal(await session.current(), dedicated);
  popup.navigate("https://auth.openai.com/password/reset");
  assert.equal(await session.current(), popup);

  dedicated.navigate("https://chatgpt.com/auth/login");
  assert.equal(await session.current(), popup);
});

test("rescans context pages when an allowed auth popup event is missed", async () => {
  const context = new FakeContext([]);
  const session = await createControlledPageSession(context, [
    "https://chatgpt.com",
    "https://auth.openai.com",
  ]);
  const popup = new FakePage("https://auth.openai.com/log-in/password");
  context.existing.push(popup);

  assert.equal(await session.current(), popup);
});

class FakePage extends EventEmitter {
  constructor(url) {
    super();
    this.currentUrl = url;
  }

  url() {
    return this.currentUrl;
  }

  navigate(url) {
    this.currentUrl = url;
    this.emit("framenavigated", {});
  }
}

class FakeContext extends EventEmitter {
  constructor(pages) {
    super();
    this.existing = pages;
    this.created = 0;
  }

  pages() {
    return this.existing;
  }

  async newPage() {
    this.created += 1;
    const page = new FakePage("about:blank");
    this.existing.push(page);
    return page;
  }
}
