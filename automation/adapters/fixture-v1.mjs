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
