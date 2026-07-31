import {
  PROTOCOL_VERSION,
  sanitizeOutbound,
} from "./account-keeper-protocol.mjs";

const FAILURE_CODES = new Set([
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
]);

export async function runAccountFlow({
  page,
  pageSession,
  adapter,
  request,
  emit,
  control,
  waitForCommand,
}) {
  const pageSource = normalizePageSource(pageSession, page);
  const commandControl = normalizeControl(control, waitForCommand);
  const credentialState = { unknown: false };
  const send = async (message) =>
    emit(
      sanitizeOutbound({
        protocol_version: PROTOCOL_VERSION,
        request_id: request.request_id,
        ...message,
      }),
    );

  try {
    if (request.operation === "verify_credentials") {
      await verifyCredentials({
        pageSource,
        adapter,
        request,
        send,
        control: commandControl,
      });
      return;
    }
    commandControl.throwIfCancelled();
    await send({ type: "stage", stage: "logging_in" });
    await runPageAction({
      pageSource,
      adapter,
      control: commandControl,
      assertOrigin: false,
      action: (currentPage) =>
        adapter.openLogin(currentPage, { control: commandControl }),
    });
    await authenticate({
      pageSource,
      adapter,
      request,
      password: request.current_password,
      send,
      control: commandControl,
    });

    commandControl.throwIfCancelled();
    await send({ type: "stage", stage: "changing_password" });
    await runPageAction({
      pageSource,
      adapter,
      control: commandControl,
      action: (currentPage) =>
        adapter.openPasswordChange(currentPage, {
          account: request.account,
          control: commandControl,
        }),
    });
    await changePassword({
      pageSource,
      adapter,
      request,
      send,
      control: commandControl,
      credentialState,
    });
    await send({ type: "password_changed" });

    await runPageAction({
      pageSource,
      adapter,
      control: commandControl,
      action: (currentPage) =>
        adapter.logout(currentPage, { control: commandControl }),
    });
    await send({ type: "stage", stage: "verifying_new_password" });
    await runPageAction({
      pageSource,
      adapter,
      control: commandControl,
      assertOrigin: false,
      action: (currentPage) =>
        adapter.openLogin(currentPage, { control: commandControl }),
    });
    const verificationCredentialsSubmitted = await authenticate({
      pageSource,
      adapter,
      request,
      password: request.new_password,
      send,
      control: commandControl,
    });
    if (!verificationCredentialsSubmitted) {
      throw flowError("verification_failed");
    }
    const signedIn = await runPageRead({
      pageSource,
      adapter,
      control: commandControl,
      read: (currentPage) =>
        adapter.verifySignedIn(currentPage, { control: commandControl }),
    });
    if (!signedIn) {
      throw flowError("verification_failed");
    }
    credentialState.unknown = false;
    await send({ type: "verified" });
  } catch (error) {
    const code = credentialState.unknown
      ? "credential_state_unknown"
      : normalizeFailureCode(error);
    await send({ type: "failed", code, message: "ignored" });
  }
}

async function verifyCredentials({
  pageSource,
  adapter,
  request,
  send,
  control,
}) {
  control.throwIfCancelled();
  await send({ type: "stage", stage: "logging_in" });
  await runPageAction({
    pageSource,
    adapter,
    control,
    assertOrigin: false,
    action: (currentPage) =>
      adapter.prepareCredentialVerification?.(currentPage, { control })
      ?? adapter.openLogin(currentPage, { control }),
  });
  let credentialsSubmitted = await authenticate({
    pageSource,
    adapter,
    request,
    password: request.current_password,
    send,
    control,
  });
  if (!credentialsSubmitted) {
    await runPageAction({
      pageSource,
      adapter,
      control,
      action: (currentPage) => adapter.logout(currentPage, { control }),
    });
    await runPageAction({
      pageSource,
      adapter,
      control,
      assertOrigin: false,
      action: (currentPage) => adapter.openLogin(currentPage, { control }),
    });
    credentialsSubmitted = await authenticate({
      pageSource,
      adapter,
      request,
      password: request.current_password,
      send,
      control,
    });
  }
  if (!credentialsSubmitted) {
    throw flowError("verification_failed");
  }
  const signedIn = await runPageRead({
    pageSource,
    adapter,
    control,
    read: (currentPage) => adapter.verifySignedIn(currentPage, { control }),
  });
  if (!signedIn) {
    throw flowError("verification_failed");
  }
  await send({ type: "verified" });
}

async function authenticate({
  pageSource,
  adapter,
  request,
  password,
  send,
  control,
}) {
  let credentialsSubmitted = false;
  let loginStepPending = false;
  let totpAttempts = 0;
  let totpPending = false;
  for (let step = 0; step < 16; step += 1) {
    let result = await classify({ pageSource, adapter, control });
    if (
      loginStepPending
      && (
        result.state === "flow_changed"
        || (credentialsSubmitted && result.state === "login_ready")
      )
    ) {
      result = await waitForLoginTransition({
        pageSource,
        adapter,
        control,
        credentialsSubmitted,
      });
    }
    loginStepPending = false;
    if (totpPending) {
      if (result.state === "totp_required" || result.state === "flow_changed") {
        result = await waitForTotpTransition({ pageSource, adapter, control });
      }
      totpPending = false;
    }
    switch (result.state) {
      case "login_ready":
        if (credentialsSubmitted) {
          throw flowError("invalid_credentials");
        }
        const submitted = await runPageAction({
          pageSource,
          adapter,
          control,
          action: (currentPage) =>
            adapter.submitCredentials(currentPage, {
              account: request.account,
              password,
            }, { control }),
        });
        if (submitted === false) {
          loginStepPending = true;
          break;
        }
        credentialsSubmitted = true;
        loginStepPending = true;
        break;
      case "totp_required":
      case "totp_rejected":
        if (result.state === "totp_rejected") {
          totpPending = false;
        }
        if (totpAttempts >= 2) {
          await waitForManual({
            result: await securityChallengeResult(pageSource, adapter, control),
            request,
            send,
            control,
          });
          break;
        }
        {
          await send({ type: "stage", stage: "submitting_totp" });
          const pendingCommand = waitForExpected(
            control,
            "totp_code",
            request.request_id,
          );
          await send({ type: "totp_required" });
          const command = await pendingCommand;
          await runPageAction({
            pageSource,
            adapter,
            control,
            action: (currentPage) =>
              adapter.submitTotp(currentPage, command.code, { control }),
          });
        }
        totpAttempts += 1;
        totpPending = true;
        break;
      case "manual_required":
        await waitForManual({ result, request, send, control });
        break;
      case "signed_in":
        return credentialsSubmitted;
      case "invalid_credentials":
        throw flowError("invalid_credentials");
      case "unsupported_login_method":
        throw flowError("unsupported_login_method");
      case "flow_changed":
        throw flowError("flow_changed");
      default:
        throw flowError("flow_changed");
    }
  }
  throw flowError("navigation_failed");
}

async function changePassword({
  pageSource,
  adapter,
  request,
  send,
  control,
  credentialState,
}) {
  let passwordSubmitted = false;
  let identityChallengeSubmitted = false;
  let totpAttempts = 0;
  let totpPending = false;
  for (let step = 0; step < 16; step += 1) {
    let result = await classifyPasswordChange({ pageSource, adapter, control });
    if (totpPending) {
      if (result.state === "totp_required" || result.state === "flow_changed") {
        result = await waitForTotpTransition({
          pageSource,
          adapter,
          control,
          classifyPage: classifyPasswordChange,
        });
      }
      totpPending = false;
    }
    switch (result.state) {
      case "identity_challenge":
        if (identityChallengeSubmitted) {
          throw flowError("password_change_failed");
        }
        await runPageAction({
          pageSource,
          adapter,
          control,
          action: (currentPage) =>
            adapter.submitIdentityChallenge(
              currentPage,
              request.current_password,
              { control },
            ),
        });
        identityChallengeSubmitted = true;
        break;
      case "totp_required":
      case "totp_rejected":
        if (result.state === "totp_rejected") {
          totpPending = false;
        }
        if (totpAttempts >= 2) {
          await waitForManual({
            result: await securityChallengeResult(pageSource, adapter, control),
            request,
            send,
            control,
          });
          break;
        }
        {
          await send({ type: "stage", stage: "submitting_totp" });
          const pendingCommand = waitForExpected(
            control,
            "totp_code",
            request.request_id,
          );
          await send({ type: "totp_required" });
          const command = await pendingCommand;
          await runPageAction({
            pageSource,
            adapter,
            control,
            action: (currentPage) =>
              adapter.submitTotp(currentPage, command.code, { control }),
          });
        }
        totpAttempts += 1;
        totpPending = true;
        break;
      case "password_change_ready":
        if (passwordSubmitted) {
          throw flowError("password_change_failed");
        }
        await submitPasswordChange({
          pageSource,
          adapter,
          request,
          send,
          control,
          credentialState,
        });
        passwordSubmitted = true;
        break;
      case "password_changed":
        return;
      case "manual_required":
        await waitForManual({ result, request, send, control });
        break;
      case "flow_changed":
        throw flowError("flow_changed");
      default:
        throw flowError("password_change_failed");
    }
  }
  throw flowError("password_change_failed");
}

async function submitPasswordChange({
  pageSource,
  adapter,
  request,
  send,
  control,
  credentialState,
}) {
  control.throwIfCancelled();
  const currentPage = await pageSource.current();
  control.throwIfCancelled();
  await assertAdapterOrigin(adapter, currentPage);
  control.throwIfCancelled();
  const authorization = control.waitFor("submit_password");
  await send({ type: "password_submit_required" });
  await waitForPasswordSubmitAuthorization(
    authorization,
    control,
    request.request_id,
    credentialState,
  );
  await adapter.submitPasswordChange(
    currentPage,
    {
      currentPassword: request.current_password,
      newPassword: request.new_password,
    },
    { control },
  );
  control.throwIfCancelled();
}

async function waitForPasswordSubmitAuthorization(
  authorization,
  control,
  requestId,
  credentialState,
) {
  const command = await authorization;
  if (!command || command.request_id !== requestId) {
    throw flowError("protocol_error");
  }
  if (command.type === "cancel") {
    throw flowError("cancelled");
  }
  if (command.type !== "submit_password") {
    throw flowError("protocol_error");
  }
  credentialState.unknown = true;
  control.throwIfCancelled();
}

async function waitForManual({ result, request, send, control }) {
  await send({ type: "stage", stage: "waiting_manual" });
  await send({
    type: "manual_required",
    reason: result.reason,
    url: result.url,
  });
  await waitForExpected(control, "resume", request.request_id);
}

async function waitForExpected(control, expectedType, requestId) {
  control.throwIfCancelled();
  const command = await control.waitFor(expectedType);
  if (!command || command.request_id !== requestId) {
    throw flowError("protocol_error");
  }
  if (command.type === "cancel") {
    throw flowError("cancelled");
  }
  if (command.type !== expectedType) {
    throw flowError("protocol_error");
  }
  control.throwIfCancelled();
  return command;
}

async function classify({ pageSource, adapter, control }) {
  return normalizeState(
    await runPageRead({
      pageSource,
      adapter,
      control,
      read: (currentPage) => adapter.classify(currentPage),
    }),
  );
}

async function classifyPasswordChange({ pageSource, adapter, control }) {
  return normalizeState(
    await runPageRead({
      pageSource,
      adapter,
      control,
      read: (currentPage) => adapter.classifyPasswordChange(currentPage),
    }),
  );
}

async function waitForTotpTransition({
  pageSource,
  adapter,
  control,
  classifyPage = classify,
}) {
  for (let poll = 0; poll < 150; poll += 1) {
    await cancellableDelay(control, 100);
    const result = await classifyPage({ pageSource, adapter, control });
    if (result.state !== "totp_required" && result.state !== "flow_changed") {
      return result;
    }
  }
  throw flowError("navigation_failed");
}

async function waitForLoginTransition({
  pageSource,
  adapter,
  control,
  credentialsSubmitted = false,
}) {
  for (let poll = 0; poll < 150; poll += 1) {
    await cancellableDelay(control, 100);
    const result = await classify({ pageSource, adapter, control });
    if (
      result.state !== "flow_changed"
      && !(credentialsSubmitted && result.state === "login_ready")
    ) {
      return result;
    }
  }
  throw flowError("navigation_failed");
}

async function cancellableDelay(control, milliseconds) {
  control.throwIfCancelled();
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  control.throwIfCancelled();
}

async function securityChallengeResult(pageSource, adapter, control) {
  control.throwIfCancelled();
  const currentPage = await pageSource.current();
  control.throwIfCancelled();
  await assertAdapterOrigin(adapter, currentPage);
  control.throwIfCancelled();
  const url =
    typeof currentPage.url === "function" ? currentPage.url() : adapter.loginUrl;
  return {
    state: "manual_required",
    reason: "security_challenge",
    url,
  };
}

async function runPageAction({
  pageSource,
  adapter,
  control,
  action,
  assertOrigin = true,
}) {
  control.throwIfCancelled();
  const currentPage = await pageSource.current();
  control.throwIfCancelled();
  if (assertOrigin) {
    await assertAdapterOrigin(adapter, currentPage);
    control.throwIfCancelled();
  }
  const result = await action(currentPage);
  control.throwIfCancelled();
  if (
    result
    && typeof result.url === "function"
    && typeof pageSource.adopt === "function"
  ) {
    pageSource.adopt(result);
    control.throwIfCancelled();
  }
  return result;
}

async function runPageRead({ pageSource, adapter, control, read }) {
  control.throwIfCancelled();
  const currentPage = await pageSource.current();
  control.throwIfCancelled();
  await assertAdapterOrigin(adapter, currentPage);
  control.throwIfCancelled();
  const result = await read(currentPage);
  control.throwIfCancelled();
  return result;
}

function normalizePageSource(pageSession, page) {
  if (pageSession && typeof pageSession.current === "function") {
    return pageSession;
  }
  if (!page) {
    throw flowError("protocol_error");
  }
  return { current: async () => page };
}

function normalizeControl(control, waitForCommand) {
  if (
    control &&
    typeof control.throwIfCancelled === "function" &&
    typeof control.waitFor === "function"
  ) {
    return control;
  }
  if (typeof waitForCommand !== "function") {
    throw flowError("protocol_error");
  }
  return {
    throwIfCancelled() {},
    waitFor: () => waitForCommand(),
  };
}

function normalizeState(value) {
  if (typeof value === "string") {
    return { state: value };
  }
  if (!value || typeof value !== "object" || typeof value.state !== "string") {
    throw flowError("flow_changed");
  }
  return value;
}

async function assertAdapterOrigin(adapter, page) {
  if (typeof adapter.assertAllowedOrigin === "function") {
    await adapter.assertAllowedOrigin(page);
  }
}

function flowError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeFailureCode(error) {
  if (error && FAILURE_CODES.has(error.code)) {
    return error.code;
  }
  return "navigation_failed";
}
