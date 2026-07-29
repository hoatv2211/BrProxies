import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_LINE_BYTES,
  createInboundDecoder,
  encodeOutbound,
  parseInbound,
  sanitizeOutbound,
} from "../account-keeper-protocol.mjs";

const validStart = () => ({
  protocol_version: 1,
  type: "start",
  request_id: "req_1",
  adapter_id: "fixture-v1",
  cdp_endpoint: "http://127.0.0.1:9222",
  account: "synthetic@example.test",
  current_password: "synthetic-current",
  new_password: "synthetic-new",
});

test("parses a valid start message", () => {
  const parsed = parseInbound(JSON.stringify(validStart()));
  assert.deepEqual(parsed, validStart());
});

test("parses explicit password submit authorization", () => {
  const message = {
    protocol_version: 1,
    type: "submit_password",
    request_id: "req_1",
  };
  assert.deepEqual(parseInbound(JSON.stringify(message)), message);
});

test("rejects missing request IDs", () => {
  const message = validStart();
  delete message.request_id;
  assert.throws(() => parseInbound(JSON.stringify(message)), /request_id/);
});

test("rejects unknown adapter IDs", () => {
  const message = validStart();
  message.adapter_id = "unknown-v1";
  assert.throws(() => parseInbound(JSON.stringify(message)), /adapter_id/);
});

test("rejects oversized inbound lines", () => {
  assert.throws(() => parseInbound("x".repeat(MAX_LINE_BYTES + 1)), /64 KiB/);
});

test("rejects outbound secret fields recursively", () => {
  assert.throws(
    () =>
      sanitizeOutbound({
        protocol_version: 1,
        type: "stage",
        request_id: "req_1",
        stage: "logging_in",
        nested: { password: "synthetic-secret" },
      }),
    /forbidden field/,
  );
});

test("removes query and fragment from manual URL", () => {
  const message = sanitizeOutbound({
    protocol_version: 1,
    type: "manual_required",
    request_id: "req_1",
    reason: "captcha",
    url: "https://example.test/path?token=x#fragment",
  });
  assert.equal(message.url, "https://example.test/path");
});

test("allows a credential-free password submit request", () => {
  assert.deepEqual(
    sanitizeOutbound({
      protocol_version: 1,
      type: "password_submit_required",
      request_id: "req_1",
    }),
    {
      protocol_version: 1,
      type: "password_submit_required",
      request_id: "req_1",
    },
  );
});

test("rejects unknown outbound fields", () => {
  assert.throws(
    () =>
      sanitizeOutbound({
        protocol_version: 1,
        type: "verified",
        request_id: "req_1",
        html: "<body>secret</body>",
      }),
    /forbidden field/,
  );
});

test("canonicalizes failure messages so secrets cannot pass in values", () => {
  const message = sanitizeOutbound({
    protocol_version: 1,
    type: "failed",
    request_id: "req_1",
    code: "flow_changed",
    message: "synthetic-password",
  });
  assert.equal(message.message, "Supported page structure changed");
  assert.equal(JSON.stringify(message).includes("synthetic-password"), false);
});

test("canonicalizes unknown credential state failures", () => {
  const message = sanitizeOutbound({
    protocol_version: 1,
    type: "failed",
    request_id: "req_1",
    code: "credential_state_unknown",
    message: "ignored",
  });
  assert.equal(
    message.message,
    "Password submission outcome is unknown; verify credentials manually",
  );
});

test("rejects unknown failure codes", () => {
  assert.throws(
    () =>
      sanitizeOutbound({
        protocol_version: 1,
        type: "failed",
        request_id: "req_1",
        code: "arbitrary_failure",
        message: "Arbitrary failure",
      }),
    /failure code/,
  );
});

test("encodes one sanitized NDJSON line", () => {
  const line = encodeOutbound({
    protocol_version: 1,
    type: "stage",
    request_id: "req_1",
    stage: "verifying_new_password",
  });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.trim().split("\n").length, 1);
});

test("decodes chunked NDJSON input", () => {
  const messages = [];
  const decoder = createInboundDecoder((message) => messages.push(message));
  const line = `${JSON.stringify(validStart())}\n`;
  decoder.push(line.slice(0, 17));
  decoder.push(line.slice(17));
  decoder.end();
  assert.deepEqual(messages, [validStart()]);
});
