export function createFixturePage(states) {
  return {
    states: [...states],
    actions: [],
    currentState: null,
  };
}

const fixtureOrigin = resolveFixtureOrigin();

export const fixtureAdapter = {
  id: "fixture-v1",
  allowedOrigins: [fixtureOrigin],
  loginUrl: `${fixtureOrigin}/login`,

  async assertAllowedOrigin(page) {
    if (isSyntheticPage(page)) return;
    const origin = new URL(page.url()).origin;
    if (!this.allowedOrigins.includes(origin)) {
      throw codedError("navigation_failed");
    }
  },

  async openLogin(page, { control } = {}) {
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "open_login" });
      return;
    }
    control?.throwIfCancelled?.();
    await page.goto(this.loginUrl);
    control?.throwIfCancelled?.();
  },

  async classify(page) {
    if (isSyntheticPage(page)) {
      const state = page.states.shift();
      if (state === undefined) {
        page.currentState = "flow_changed";
        return "flow_changed";
      }
      page.currentState = typeof state === "string" ? state : state.state;
      return state;
    }

    if (await visible(page.getByTestId("manual-challenge"))) {
      return {
        state: "manual_required",
        reason: "security_challenge",
        url: page.url(),
      };
    }
    if (await visible(page.getByText("Password changed successfully", { exact: true }))) {
      return "password_changed";
    }
    if (await visible(page.getByLabel("Current password", { exact: true }))) {
      return "password_change_ready";
    }
    if (await visible(page.getByLabel("Verification code", { exact: true }))) {
      if (await visible(page.getByText("Verification code rejected", { exact: true }))) {
        return "totp_rejected";
      }
      return "totp_required";
    }
    if (
      await visible(page.getByLabel("Account", { exact: true }))
      && await visible(page.getByLabel("Password", { exact: true }))
    ) {
      return "login_ready";
    }
    if (await visible(page.getByRole("heading", { name: "Account home", exact: true }))) {
      return "signed_in";
    }
    return "flow_changed";
  },

  async classifyPasswordChange(page) {
    const state = await this.classify(page);
    if (
      !isSyntheticPage(page)
      && state === "password_change_ready"
      && !(await visible(page.getByLabel("New password", { exact: true })))
    ) {
      return "identity_challenge";
    }
    return state;
  },

  async submitCredentials(page, credentials, { control } = {}) {
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "submit_credentials", ...credentials });
      return;
    }
    control?.throwIfCancelled?.();
    await page.getByLabel("Account", { exact: true }).fill(credentials.account);
    control?.throwIfCancelled?.();
    await page.getByLabel("Password", { exact: true }).fill(credentials.password);
    control?.throwIfCancelled?.();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    control?.throwIfCancelled?.();
  },

  async submitTotp(page, code, { control } = {}) {
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "submit_totp", code });
      return;
    }
    control?.throwIfCancelled?.();
    await page.getByLabel("Verification code", { exact: true }).fill(code);
    control?.throwIfCancelled?.();
    await page.getByRole("button", { name: "Verify", exact: true }).click();
    control?.throwIfCancelled?.();
  },

  async submitIdentityChallenge(page, currentPassword, { control } = {}) {
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "submit_identity_challenge", currentPassword });
      return;
    }
    control?.throwIfCancelled?.();
    const input = page.getByLabel("Current password", { exact: true });
    await input.fill(currentPassword);
    control?.throwIfCancelled?.();
    await page.getByRole("button", { name: /^(Continue|Verify)$/ }).click();
    control?.throwIfCancelled?.();
    await waitUntilHidden(page, input, 15_000, control);
  },

  async openPasswordChange(page, { control } = {}) {
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "open_password_change" });
      return;
    }
    control?.throwIfCancelled?.();
    await page.getByRole("link", { name: "Change password", exact: true }).click();
    control?.throwIfCancelled?.();
  },

  async submitPasswordChange(page, passwords, { control, onBeforeSubmit } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      onBeforeSubmit?.();
      page.actions.push({ type: "submit_password_change", ...passwords });
      control?.throwIfCancelled?.();
      return;
    }
    await page.getByLabel("Current password", { exact: true }).fill(passwords.currentPassword);
    control?.throwIfCancelled?.();
    await page.getByLabel("New password", { exact: true }).fill(passwords.newPassword);
    control?.throwIfCancelled?.();
    await page.getByLabel("Confirm new password", { exact: true }).fill(passwords.newPassword);
    control?.throwIfCancelled?.();
    onBeforeSubmit?.();
    await page.getByRole("button", { name: "Update password", exact: true }).click();
    control?.throwIfCancelled?.();
  },

  async openTotpChange(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "open_totp_change" });
      return;
    }
    throw codedError("flow_changed");
  },

  async inspectTotpChange(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "inspect_totp_change" });
      if (page.actions.some((action) => action.type === "open_totp_enrollment")) {
        return "enrollment";
      }
      if (page.actions.some((action) => action.type === "confirm_totp_disable")) {
        return "disabled";
      }
      return "enabled";
    }
    throw codedError("flow_changed");
  },

  async beginTotpDisable(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "begin_totp_disable" });
      return page;
    }
    throw codedError("flow_changed");
  },

  async submitTotpDisableIdentity(page, password, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "submit_totp_disable_identity", password });
      return page;
    }
    throw codedError("flow_changed");
  },

  async inspectTotpDisable(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      if (page.actions.some((action) => action.type === "confirm_totp_disable")) {
        return "disabled";
      }
      if (!page.actions.some((action) => action.type === "submit_totp_disable_identity")) {
        return "identity_challenge";
      }
      return "confirmation";
    }
    throw codedError("flow_changed");
  },

  async submitTotpDisableChallenge(page, code, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "submit_totp_disable_challenge", code });
      return page;
    }
    throw codedError("flow_changed");
  },

  async confirmTotpDisable(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "confirm_totp_disable" });
      return page;
    }
    throw codedError("flow_changed");
  },

  async openTotpEnrollment(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "open_totp_enrollment" });
      return;
    }
    throw codedError("flow_changed");
  },

  async readTotpEnrollment(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "read_totp_enrollment" });
      return "JBSWY3DPEHPK3PXP";
    }
    throw codedError("flow_changed");
  },

  async submitTotpEnrollment(page, code, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "submit_totp_enrollment", code });
      return;
    }
    throw codedError("flow_changed");
  },

  async verifyTotpChanged(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "verify_totp_changed" });
      return true;
    }
    return false;
  },

  async openEmailChange(page, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "open_email_change" });
      return;
    }
    throw codedError("flow_changed");
  },

  async submitEmailChange(page, email, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "submit_email_change", email });
      return;
    }
    throw codedError("flow_changed");
  },

  async submitEmailVerification(page, code, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "submit_email_verification", code });
      return;
    }
    throw codedError("flow_changed");
  },

  async verifyEmailChanged(page, email, { control } = {}) {
    control?.throwIfCancelled?.();
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "verify_email_changed", email });
      return true;
    }
    return false;
  },

  async logout(page, { control } = {}) {
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "logout" });
      return;
    }
    control?.throwIfCancelled?.();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    control?.throwIfCancelled?.();
  },

  async verifySignedIn(page) {
    if (isSyntheticPage(page)) {
      page.actions.push({ type: "verify_signed_in" });
      return page.currentState === "signed_in";
    }
    return visible(page.getByRole("heading", { name: "Account home", exact: true }));
  },
};

function isSyntheticPage(page) {
  return Array.isArray(page?.states) && Array.isArray(page?.actions);
}

async function visible(locator) {
  return locator.first().isVisible().catch(() => false);
}

async function waitUntilHidden(page, locator, timeout, control) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    control?.throwIfCancelled?.();
    if (!(await visible(locator))) {
      control?.throwIfCancelled?.();
      return;
    }
    control?.throwIfCancelled?.();
    await page.waitForTimeout(100);
    control?.throwIfCancelled?.();
  }
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resolveFixtureOrigin() {
  const value = process.env.ACCOUNT_KEEPER_FIXTURE_ORIGIN;
  if (!value) return "https://fixture.test";
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:"
      && url.hostname === "127.0.0.1"
      && url.port !== ""
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
    ) {
      return url.origin;
    }
  } catch {}
  return "https://fixture.test";
}
