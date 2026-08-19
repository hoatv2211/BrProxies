export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 64 * 1024;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const FAILURE_MESSAGES = new Map([
  ["browser_crashed", "Browser connection closed"],
  ["cancelled", "Operation cancelled"],
  [
    "credential_state_unknown",
    "Password submission outcome is unknown; verify credentials manually",
  ],
  ["flow_changed", "Supported page structure changed"],
  ["invalid_credentials", "Current credentials were rejected"],
  ["navigation_failed", "Navigation failed"],
  ["password_change_failed", "Password change failed"],
  ["protocol_error", "Worker protocol failed"],
  ["totp_rejected", "TOTP verification failed"],
  ["unsupported_login_method", "Account uses an unsupported login method"],
  ["verification_failed", "New password verification failed"],
  ["worker_not_ready", "Browser flow is not provisioned"],
]);
const ADAPTER_IDS = new Set(["fixture-v1", "openai-chatgpt-v1"]);
const OPERATIONS = new Set(["change_password", "verify_credentials", "change_totp", "change_email", "codex_oauth"]);
const STAGES = new Set([
  "launching",
  "logging_in",
  "submitting_totp",
  "changing_password",
  "verifying_new_password",
  "changing_totp",
  "verifying_new_totp",
  "changing_email",
  "waiting_email_verification",
  "verifying_new_email",
  "waiting_manual",
]);
const MANUAL_REASONS = new Set([
  "captcha",
  "email_verification",
  "security_challenge",
  "unknown_challenge",
  "unusual_login",
]);
const FORBIDDEN_FIELD_PARTS = [
  "account",
  "authorization",
  "authheader",
  "cookie",
  "email",
  "formvalue",
  "html",
  "identifier",
  "password",
  "secret",
  "storage",
  "token",
];

const INBOUND_FIELDS = {
  start: new Set([
    "protocol_version",
    "type",
    "request_id",
    "operation",
    "adapter_id",
    "cdp_endpoint",
    "account",
    "current_password",
    "new_password",
    "new_email",
    "oauth_url",
  ]),
  totp_code: new Set(["protocol_version", "type", "request_id", "code"]),
  submit_totp_disable: new Set(["protocol_version", "type", "request_id"]),
  totp_enrollment_code: new Set(["protocol_version", "type", "request_id", "code"]),
  email_verification_code: new Set(["protocol_version", "type", "request_id", "code"]),
  submit_password: new Set(["protocol_version", "type", "request_id"]),
  resume: new Set(["protocol_version", "type", "request_id"]),
  cancel: new Set(["protocol_version", "type", "request_id"]),
};

const OUTBOUND_FIELDS = {
  stage: new Set(["protocol_version", "type", "request_id", "stage"]),
  totp_required: new Set(["protocol_version", "type", "request_id"]),
  manual_required: new Set([
    "protocol_version",
    "type",
    "request_id",
    "reason",
    "url",
  ]),
  password_submit_required: new Set(["protocol_version", "type", "request_id"]),
  totp_disable_required: new Set(["protocol_version", "type", "request_id"]),
  password_changed: new Set(["protocol_version", "type", "request_id"]),
  totp_enrollment_secret: new Set(["protocol_version", "type", "request_id", "value"]),
  totp_changed: new Set(["protocol_version", "type", "request_id"]),
  email_verification_required: new Set(["protocol_version", "type", "request_id"]),
  email_changed: new Set(["protocol_version", "type", "request_id"]),
  verified: new Set(["protocol_version", "type", "request_id"]),
  oauth_opened: new Set(["protocol_version", "type", "request_id"]),
  failed: new Set([
    "protocol_version",
    "type",
    "request_id",
    "code",
    "message",
  ]),
};

export function parseInbound(line) {
  const text = normalizeLine(line);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new Error("invalid JSON protocol line");
  }
  assertPlainObject(message, "inbound message");
  assertProtocolVersion(message);
  assertRequestId(message.request_id);
  const allowedFields = INBOUND_FIELDS[message.type];
  if (!allowedFields) {
    throw new Error("unsupported inbound message type");
  }
  assertAllowedFields(message, allowedFields);

  switch (message.type) {
    case "start":
      assertAllowedValue(
        message.operation ?? "change_password",
        OPERATIONS,
        "operation",
      );
      assertAllowedValue(message.adapter_id, ADAPTER_IDS, "adapter_id");
      assertString(message.cdp_endpoint, "cdp_endpoint", 1, 256);
      if (message.operation === "codex_oauth") {
        assertString(message.oauth_url, "oauth_url", 1, 4096);
        for (const field of ["account", "current_password", "new_password", "new_email"]) {
          if (message[field] !== undefined) throw new Error(`${field} is not valid for codex_oauth`);
        }
        break;
      }
      assertString(message.account, "account", 1, 320);
      assertString(message.current_password, "current_password", 1, 128);
      assertString(
        message.new_password,
        "new_password",
        (message.operation ?? "change_password") === "change_password" ? 12 : 0,
        128,
      );
      if (message.operation === "change_email") {
        assertString(message.new_email, "new_email", 3, 320);
      } else if (message.new_email !== undefined) {
        throw new Error("new_email is only valid for change_email");
      }
      break;
    case "totp_code":
    case "totp_enrollment_code":
    case "email_verification_code":
      if (typeof message.code !== "string" || !/^\d{6}$/.test(message.code)) {
        throw new Error("code must be a six-digit value");
      }
      break;
    case "submit_password":
    case "submit_totp_disable":
    case "resume":
    case "cancel":
      break;
    default:
      throw new Error("unsupported inbound message type");
  }
  return message;
}

export function sanitizeOutbound(message) {
  assertPlainObject(message, "outbound message");
  assertNoForbiddenFields(message);
  assertProtocolVersion(message);
  assertRequestId(message.request_id);
  const allowedFields = OUTBOUND_FIELDS[message.type];
  if (!allowedFields) {
    throw new Error("unsupported outbound message type");
  }
  assertAllowedFields(message, allowedFields);

  const sanitized = { ...message };
  switch (message.type) {
    case "stage":
      assertAllowedValue(message.stage, STAGES, "stage");
      break;
    case "manual_required":
      assertAllowedValue(message.reason, MANUAL_REASONS, "reason");
      sanitized.url = sanitizeUrl(message.url);
      break;
    case "failed":
      if (typeof message.code !== "string" || !FAILURE_MESSAGES.has(message.code)) {
        throw new Error("invalid normalized failure code");
      }
      sanitized.message = FAILURE_MESSAGES.get(message.code);
      break;
    case "totp_required":
    case "password_submit_required":
    case "totp_disable_required":
    case "password_changed":
    case "totp_changed":
    case "email_verification_required":
    case "email_changed":
    case "verified":
    case "oauth_opened":
      break;
    case "totp_enrollment_secret":
      assertString(message.value, "value", 16, 256);
      break;
    default:
      throw new Error("unsupported outbound message type");
  }
  return sanitized;
}

export function encodeOutbound(message) {
  const line = `${JSON.stringify(sanitizeOutbound(message))}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
    throw new Error("protocol line exceeds 64 KiB");
  }
  return line;
}

export function createInboundDecoder(onMessage) {
  if (typeof onMessage !== "function") {
    throw new Error("onMessage callback is required");
  }
  let pending = "";

  const processPending = (flush) => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) {
        if (flush && pending.length > 0) {
          const line = pending;
          pending = "";
          onMessage(parseInbound(line));
        }
        if (Buffer.byteLength(pending, "utf8") > MAX_LINE_BYTES) {
          throw new Error("protocol line exceeds 64 KiB");
        }
        return;
      }
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.endsWith("\r")) {
        onMessage(parseInbound(line.slice(0, -1)));
      } else {
        onMessage(parseInbound(line));
      }
    }
  };

  return {
    push(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      processPending(false);
    },
    end() {
      processPending(true);
    },
  };
}

export function withPasswordSubmitAuthorization(control) {
  if (
    !control ||
    typeof control.push !== "function" ||
    typeof control.waitFor !== "function" ||
    typeof control.throwIfCancelled !== "function"
  ) {
    throw new Error("command control is required");
  }
  const authorizationTypes = new Set(["submit_password", "submit_totp_disable"]);
  let authorizationWaiter = null;

  return {
    throwIfCancelled: () => control.throwIfCancelled(),
    waitForAny(expectedTypes) {
      return control.waitForAny(expectedTypes);
    },
    waitFor(expectedType) {
      if (!authorizationTypes.has(expectedType)) {
        return control.waitFor(expectedType);
      }
      control.throwIfCancelled();
      if (authorizationWaiter) {
        return Promise.reject(codedProtocolError());
      }
      return new Promise((resolve) => {
        authorizationWaiter = { expectedType, resolve };
      });
    },
    push(message) {
      if (message?.type === "cancel") {
        const accepted = control.push(message);
        if (accepted && authorizationWaiter) {
          const { resolve } = authorizationWaiter;
          authorizationWaiter = null;
          resolve(message);
        }
        return accepted;
      }
      if (authorizationTypes.has(message?.type)) {
        try {
          control.throwIfCancelled();
        } catch {
          return false;
        }
        if (
          !authorizationWaiter
          || message.type !== authorizationWaiter.expectedType
          || message.request_id !== control.requestId
        ) {
          return false;
        }
        const { resolve } = authorizationWaiter;
        authorizationWaiter = null;
        resolve(message);
        return true;
      }
      return control.push(message);
    },
  };
}

function normalizeLine(line) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : String(line);
  if (Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) {
    throw new Error("protocol line exceeds 64 KiB");
  }
  const normalized = text.endsWith("\r") ? text.slice(0, -1) : text;
  if (normalized.length === 0 || normalized.includes("\n") || normalized.includes("\r")) {
    throw new Error("protocol input must contain exactly one line");
  }
  return normalized;
}

function codedProtocolError() {
  const error = new Error("protocol_error");
  error.code = "protocol_error";
  return error;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertProtocolVersion(message) {
  if (message.protocol_version !== PROTOCOL_VERSION) {
    throw new Error(`protocol_version must be ${PROTOCOL_VERSION}`);
  }
}

function assertRequestId(value) {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
    throw new Error("invalid or missing request_id");
  }
}

function assertString(value, field, minimum, maximum) {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`invalid ${field}`);
  }
}

function assertAllowedValue(value, allowed, field) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new Error(`unsupported ${field}`);
  }
}

function assertAllowedFields(message, allowedFields) {
  for (const field of Object.keys(message)) {
    if (!allowedFields.has(field)) {
      throw new Error(`unsupported protocol field: ${field}`);
    }
  }
}

function assertNoForbiddenFields(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoForbiddenFields(item);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  for (const [field, nested] of Object.entries(value)) {
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (FORBIDDEN_FIELD_PARTS.some((part) => normalized.includes(part))) {
      throw new Error(`forbidden field in worker output: ${field}`);
    }
    assertNoForbiddenFields(nested);
  }
}

function sanitizeUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("invalid manual URL");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid manual URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("invalid manual URL protocol");
  }
  return `${url.origin}${url.pathname}`;
}
