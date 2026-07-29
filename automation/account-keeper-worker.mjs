import { chromium } from "patchright";

import { runAccountFlow } from "./account-keeper-flow.mjs";
import {
  PROTOCOL_VERSION,
  createInboundDecoder,
  encodeOutbound,
  withPasswordSubmitAuthorization,
} from "./account-keeper-protocol.mjs";
import { getAdapter } from "./adapters/registry.mjs";
import {
  CommandControl,
  createControlledPageSession,
  validateCdpEndpoint,
} from "./account-keeper-worker-runtime.mjs";

let active = null;

const decoder = createInboundDecoder((message) => {
  void handleMessage(message).catch(() => failProtocol(message.request_id ?? "protocol"));
});

process.stdin.on("data", (chunk) => {
  try {
    decoder.push(chunk);
  } catch {
    void failProtocol("protocol");
  }
});

process.stdin.on("end", () => {
  try {
    decoder.end();
  } catch {
    void failProtocol("protocol");
  }
});

async function handleMessage(message) {
  if (message.type === "start") {
    if (active) {
      await emitFailure(message.request_id, "protocol_error");
      return;
    }
    active = {
      requestId: message.request_id,
      control: withPasswordSubmitAuthorization(
        new CommandControl(message.request_id),
      ),
    };
    void runStart(message, active);
    return;
  }

  if (!active || message.request_id !== active.requestId) {
    await emitFailure(message.request_id, "protocol_error");
    return;
  }
  active.control.push(message);
}

async function runStart(request, session) {
  try {
    const endpoint = validateCdpEndpoint(request.cdp_endpoint);
    const browser = await chromium.connectOverCDP(endpoint);
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      throw codedError("browser_crashed");
    }
    const context = contexts[0];
    const adapter = getAdapter(request.adapter_id);
    const pageSession = await createControlledPageSession(
      context,
      adapter.allowedOrigins,
    );
    await runAccountFlow({
      pageSession,
      adapter,
      request,
      emit: writeMessage,
      control: session.control,
    });
  } catch (error) {
    await emitFailure(request.request_id, normalizeWorkerError(error));
  } finally {
    active = null;
    await exitAfterFlush();
  }
}

async function writeMessage(message) {
  await new Promise((resolve, reject) => {
    process.stdout.write(encodeOutbound(message), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function emitFailure(requestId, code) {
  await writeMessage({
    protocol_version: PROTOCOL_VERSION,
    type: "failed",
    request_id: requestId,
    code,
    message: "ignored",
  });
}

async function failProtocol(requestId) {
  await emitFailure(requestId, "protocol_error").catch(() => {});
  await exitAfterFlush();
}

async function exitAfterFlush() {
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(0);
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeWorkerError(error) {
  return [
    "browser_crashed",
    "cancelled",
    "credential_state_unknown",
    "flow_changed",
    "invalid_credentials",
    "navigation_failed",
    "password_change_failed",
    "protocol_error",
    "totp_rejected",
    "unsupported_login_method",
    "verification_failed",
  ].includes(error?.code)
    ? error.code
    : "browser_crashed";
}
