import { appendFileSync } from "node:fs";

const ALLOWED_ORIGINS = new Set(["https://auth.openai.com", "https://chatgpt.com"]);
const APP_URL = "https://chatgpt.com/";
const LOGIN_URL = "https://chatgpt.com/auth/login";

// Diagnostic tracing gated behind an env var. Off by default so production runs
// are unaffected. Logs metadata only (element visibility/enabled flags, error
// names/messages) — never account, password, TOTP, or field values.
function akDebugEnabled() {
  return Boolean(process.env.BRPROXIES_AK_DEBUG);
}

function akDebug(event, data) {
  const target = process.env.BRPROXIES_AK_DEBUG;
  if (!target) {
    return;
  }
  try {
    appendFileSync(
      target,
      `${JSON.stringify({ t: Date.now(), event, ...data })}\n`,
    );
  } catch {
    // Diagnostics must never break the flow.
  }
}

// Probe an input's actionability for the diagnostic log. Only runs when tracing
// is enabled — off by default so production and tests skip the DOM reads.
async function akDebugInput(event, locator) {
  if (!akDebugEnabled()) {
    return;
  }
  akDebug(event, await akInputDiag(locator));
}

function pageDebugMetadata(page) {
  try {
    const url = new URL(page.url());
    return { origin: url.origin, path: url.pathname };
  } catch {
    return { origin: null, path: null };
  }
}

function akTruncate(message) {
  if (typeof message !== "string") {
    return null;
  }
  return message.replace(/[\r\n]+/g, " ").slice(0, 200);
}

async function akProbe(locator, method) {
  if (typeof locator?.[method] !== "function") {
    return null;
  }
  try {
    return await locator[method]();
  } catch {
    return null;
  }
}

async function akInputDiag(locator) {
  return {
    visible: await akProbe(locator, "isVisible"),
    enabled: await akProbe(locator, "isEnabled"),
    editable: await akProbe(locator, "isEditable"),
  };
}

export const openaiChatgptAdapter = {
  id: "openai-chatgpt-v1",
  allowedOrigins: [...ALLOWED_ORIGINS],
  loginUrl: LOGIN_URL,

  async prepareContext(context) {
    for (const page of context.pages()) {
      let url;
      try {
        url = new URL(page.url());
      } catch {
        continue;
      }
      const staleAuthPage =
        url.origin === "https://auth.openai.com"
        || (url.origin === "https://chatgpt.com" && url.pathname.startsWith("/auth"));
      if (staleAuthPage) {
        await page.close().catch(() => {});
      }
    }
  },

  async assertAllowedOrigin(page) {
    const origin = new URL(page.url()).origin;
    if (!ALLOWED_ORIGINS.has(origin)) {
      throw adapterError("flow_changed");
    }
  },

  async openLogin(page, { control } = {}) {
    checkControl(control);
    const expiredDialog = sessionExpiredDialog(page);
    if (await visible(expiredDialog)) {
      await clickFirstVisible([
        expiredDialog.getByRole("button", { name: /log ?in|sign ?in|đăng nhập/i }),
        expiredDialog.getByRole("link", { name: /log ?in|sign ?in|đăng nhập/i }),
      ], control);
      return waitForAuthenticationSurface(page, 15_000, control);
    }
    try {
      const current = new URL(page.url());
      if (ALLOWED_ORIGINS.has(current.origin)) {
        const state = await this.classify(page);
        checkControl(control);
        if (state === "signed_in") {
          return page;
        }
      }
    } catch {
      checkControl(control);
    }
    await browserSideEffect(control, () =>
      page.goto(APP_URL, { waitUntil: "domcontentloaded" }),
    );
    await this.assertAllowedOrigin(page);
    try {
      await waitForAny(page, loginSurfaceLocators(page), 5_000, control);
      const state = await this.classify(page);
      if (
        state === "signed_in"
        || state === "login_ready"
        || state === "totp_required"
        || state === "totp_rejected"
        || state === "unsupported_login_method"
        || state?.state === "manual_required"
      ) {
        return page;
      }
    } catch (error) {
      if (error?.code !== "flow_changed") {
        throw error;
      }
    }
    await browserSideEffect(control, () =>
      page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }),
    );
    await this.assertAllowedOrigin(page);
    // ChatGPT auth is a client-rendered SPA: domcontentloaded fires before the
    // React login form mounts. Without waiting, the driver's first classify()
    // sees an empty page and throws flow_changed. Wait until an interactive
    // auth surface actually appears (or a challenge/error we still classify).
    await waitForAny(page, loginSurfaceLocators(page), 15_000, control);
    return page;
  },

  async classify(page) {
    await this.assertAllowedOrigin(page);
    const url = page.url();

    if (await anyVisible([
      page.locator('iframe[src*="challenges.cloudflare.com"]'),
      page.locator('input[name="cf-turnstile-response"]'),
      page.locator('[data-captcha]'),
    ])) {
      return { state: "manual_required", reason: "captcha", url };
    }

    if (await anyVisible([
      page.getByRole("heading", { name: /check your email/i }),
      page.getByRole("status").filter({ hasText: /check your email/i }),
    ])) {
      return { state: "manual_required", reason: "email_verification", url };
    }

    if (await anyVisible([
      page
        .getByRole("alert")
        .filter({ hasText: /(incorrect|invalid|expired).*(code|otp)|(code|otp).*(incorrect|invalid|expired)/i }),
      page
        .getByRole("status")
        .filter({ hasText: /(incorrect|invalid|expired).*(code|otp)|(code|otp).*(incorrect|invalid|expired)/i }),
    ])) {
      return "totp_rejected";
    }

    if (await visible(oneTimeCode(page))) {
      return "totp_required";
    }

    if (await anyVisible([
      page.getByRole("heading", { name: /verify|security check|unusual activity/i }),
      page.getByRole("alert").filter({ hasText: /verify|security check|unusual activity/i }),
    ])) {
      return { state: "manual_required", reason: "security_challenge", url };
    }
    if (await visible(newPassword(page))) {
      return "password_change_ready";
    }
    if (await anyVisible([
      page.getByRole("heading", { name: /password (updated|reset)/i }),
      page.getByRole("status").filter({ hasText: /password (updated|reset)/i }),
    ])) {
      return "password_changed";
    }
    if (await anyVisible([
      page
        .getByRole("alert")
        .filter({
          hasText:
            /(incorrect|invalid|wrong|does ?n['’]?t match).*(password|email|account|credential)|(password|email|account|credential).*(incorrect|invalid|wrong|does ?n['’]?t match)|wrong password|account.*not.*found|no account/i,
        }),
    ])) {
      return "invalid_credentials";
    }

    const email = emailInput(page);
    const password = currentPassword(page);
    if ((await visible(email)) || (await visible(password))) {
      return "login_ready";
    }

    const social = await anyVisible([
      page.getByRole("button", { name: /continue with (google|microsoft|apple)/i }),
      page.getByRole("link", { name: /continue with (google|microsoft|apple)/i }),
    ]);
    if (social) {
      return "unsupported_login_method";
    }

    if (await visible(sessionExpiredDialog(page))) {
      return "flow_changed";
    }

    const current = new URL(url);
    const onAppSurface =
      current.origin === "https://chatgpt.com" &&
      !current.pathname.startsWith("/auth");
    if (onAppSurface && (await anyVisible(signedOutLocators(page)))) {
      return "flow_changed";
    }
    // A post-login billing/renewal interstitial covers the shell but only shows
    // once signed in. Treat it as signed_in so the flow can dismiss it and
    // continue to the password change instead of aborting as flow_changed.
    if (onAppSurface && (await visible(blockingDialog(page)))) {
      return "signed_in";
    }
    if (onAppSurface && (await anyVisible(signedInLocators(page)))) {
      return "signed_in";
    }
    return "flow_changed";
  },

  async classifyPasswordChange(page) {
    const state = await this.classify(page);
    if (
      state?.state === "manual_required"
      && (state.reason === "captcha" || state.reason === "email_verification")
    ) {
      return state;
    }
    if (
      (state === "login_ready"
        || (state?.state === "manual_required" && state.reason === "security_challenge"))
      && await visible(currentPassword(page))
    ) {
      return "identity_challenge";
    }
    return state;
  },

  async submitCredentials(page, { account, password }, { control } = {}) {
    const email = emailInput(page);
    if (await visible(email)) {
      await akDebugInput("login_email_field", email);
      await browserSideEffect(control, () => email.fill(account));
      await clickFirstVisible([
        page.getByRole("button", { name: /^(continue|next|tiếp tục)$/i }),
        page.getByRole("button", { name: /^(log in|sign in|đăng nhập)$/i }),
        submitControl(page),
      ], control, undefined, { noWaitAfter: true });
      // ChatGPT login is a two-step SPA: email first, then password on a fresh
      // surface. The flow driver re-enters submitCredentials until credentials
      // are fully submitted, but it cannot tell the email-entry login_ready from
      // the password-entry one. Without settling here it re-classifies mid-
      // transition, still sees the email field, and re-fills in a tight loop —
      // the visible "flashing" re-type. Wait for the email field to go away so
      // the next classify lands on the password step.
      await waitUntilHidden(page, email, 15_000, control);
      const emailStillVisible = await visible(email);
      const nextFieldVisible = await visible(currentPassword(page));
      if (emailStillVisible && !nextFieldVisible) {
        // Email step never advanced (bounce back to the chooser, silent bot
        // block, or a rejected address). Surface a bounded failure instead of
        // hammering the field 16 more times.
        akDebug("login_email_stuck", {});
        throw adapterError("flow_changed");
      }
      akDebug("login_email_submitted", { next_field_visible: nextFieldVisible });
      return false;
    }

    const passwordInput = currentPassword(page);
    if (await visible(passwordInput)) {
      await akDebugInput("login_password_field", passwordInput);
      try {
        await browserSideEffect(control, () => passwordInput.fill(password));
      } catch (error) {
        akDebug("login_password_fill_error", {
          name: error?.name ?? null,
          message: akTruncate(error?.message),
        });
        throw error;
      }
      akDebug("login_password_filled", {});
      await clickFirstVisible([
        page.getByRole("button", { name: /^(continue|log in|sign in|tiếp tục|đăng nhập)$/i }),
        submitControl(page),
      ], control, undefined, { noWaitAfter: true });
      await waitUntilHidden(page, passwordInput, 15_000, control);
      return true;
    }
    throw adapterError("flow_changed");
  },

  async prepareCredentialVerification(page, { control } = {}) {
    await browserSideEffect(control, () =>
      page.goto(APP_URL, { waitUntil: "domcontentloaded" }),
    );
    for (let poll = 0; poll < 50; poll += 1) {
      checkControl(control);
      const state = await this.classify(page).catch(() => "flow_changed");
      if (state === "signed_in") {
        await this.logout(page, { control });
        break;
      }
      if (state !== "flow_changed") {
        break;
      }
      await page.waitForTimeout(100);
    }
    return this.openLogin(page, { control });
  },

  async submitTotp(page, code, { control } = {}) {
    const input = oneTimeCode(page);
    if (!(await visible(input))) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => input.fill(code));
    await clickFirstVisible([
      page.getByRole("button", { name: /^(continue|verify|submit|tiếp tục|xác minh|gửi)$/i }),
      submitControl(page),
    ], control, undefined, { noWaitAfter: true });
  },

  async submitIdentityChallenge(page, password, { control } = {}) {
    const input = currentPassword(page);
    if (!(await visible(input))) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => input.fill(password));
    await clickFirstVisible([
      page.getByRole("button", { name: /^(continue|confirm|verify|submit|tiếp tục|xác nhận|xác minh|gửi)$/i }),
      submitControl(page),
    ], control);
    await waitUntilHidden(page, input, 15_000, control);
  },

  async openPasswordChange(page, { control } = {}) {
    checkControl(control);
    const state = await this.classify(page);
    checkControl(control);
    if (state !== "signed_in") {
      throw adapterError("flow_changed");
    }
    await dismissBlockingDialog(page, control);

    const settingsLocators = [
      page.locator('[data-testid="settings-menu-item"]'),
      page.getByRole("menuitem", { name: /^(settings|cài đặt)$/i }),
      page.getByRole("button", { name: /^(settings|cài đặt)$/i }),
    ];
    let settings = await firstVisible(settingsLocators);
    if (!settings) {
      const menu = await firstVisible(accountMenuLocators(page));
      if (!menu) {
        throw adapterError("flow_changed");
      }
      await browserSideEffect(control, () => menu.click({ force: true }));
      await waitForAny(page, settingsLocators, 5_000, control);
      settings = await firstVisible(settingsLocators);
    }
    if (!settings) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => settings.click());

    const securityTabLocators = [
      page.locator('[data-testid="security-tab"]'),
      page.getByRole("tab", { name: /security( and login)?|bảo mật/i }),
    ];
    await waitForAny(page, securityTabLocators, 5_000, control);
    await clickFirstVisible(securityTabLocators, control);

    const passwordSettingLocators = [
      page.locator('[data-testid="password-setting"]'),
      page.getByRole("button", { name: /^(password|mật khẩu)\b/i }),
    ];
    await waitForAny(page, passwordSettingLocators, 5_000, control);
    await clickFirstVisible(passwordSettingLocators, control);
    await waitForAny(
      page,
      [
        currentPassword(page),
        newPassword(page),
        oneTimeCode(page),
        page.locator('iframe[src*="challenges.cloudflare.com"]'),
      ],
      15_000,
      control,
    );
    await this.assertAllowedOrigin(page);
  },

  async submitPasswordChange(
    page,
    { newPassword: value },
    { control, onBeforeSubmit } = {},
  ) {
    const inputs = page.locator('input[autocomplete="new-password"]');
    checkControl(control);
    const count = await inputs.count();
    checkControl(control);
    akDebug("password_change_inputs", { count });
    if (count === 0) {
      throw adapterError("flow_changed");
    }
    await akDebugInput("password_change_field0", inputs.nth(0));
    try {
      await browserSideEffect(control, () => inputs.nth(0).fill(value));
    } catch (error) {
      akDebug("password_change_field0_fill_error", {
        name: error?.name ?? null,
        message: akTruncate(error?.message),
      });
      throw error;
    }
    if (count > 1) {
      await akDebugInput("password_change_field1", inputs.nth(1));
      try {
        await browserSideEffect(control, () => inputs.nth(1).fill(value));
      } catch (error) {
        akDebug("password_change_field1_fill_error", {
          name: error?.name ?? null,
          message: akTruncate(error?.message),
        });
        throw error;
      }
    }
    akDebug("password_change_filled", {});
    await clickFirstVisible([
      page.getByRole("button", { name: /^(continue|reset password|update password|save)$/i }),
      submitControl(page),
    ], control, onBeforeSubmit);
    await waitUntilHidden(page, newPassword(page), 15_000, control);
    akDebug("password_change_submitted", {});
  },

  async openTotpChange(page, { control } = {}) {
    akDebug("totp_open_start", pageDebugMetadata(page));
    const readyLocators = totpChangeReadyLocators(page);
    if (await anyVisible(readyLocators)) {
      akDebug("totp_open_reuse_ready", pageDebugMetadata(page));
      await this.assertAllowedOrigin(page);
      return;
    }
    await openSettingsSection(page, this, {
      tabLocators: [
        page.locator('[data-testid="security-tab"]'),
        page.getByRole("tab", { name: /security( and login)?|bảo mật/i }),
      ],
      control,
    });
    akDebug("totp_open_security_ready", pageDebugMetadata(page));
    const settingLocators = [
      page.locator('[data-testid="mfa-setting"], [data-testid="two-factor-setting"]'),
      page.getByRole("button", { name: /multi-factor|two-factor|2fa|mfa|authenticator/i }),
    ];
    await waitForAny(page, [...readyLocators, ...settingLocators], 15_000, control);
    const readyAfterWait = await anyVisible(readyLocators);
    akDebug("totp_open_ready_probe", { ready: readyAfterWait });
    if (!readyAfterWait) {
      akDebug("totp_open_setting_probe", { visible: await anyVisible(settingLocators) });
      await clickFirstVisible(settingLocators, control);
      await waitForAny(page, readyLocators, 15_000, control);
    }
    akDebug("totp_open_complete", {
      ...pageDebugMetadata(page),
      ready: await anyVisible(readyLocators),
    });
    await this.assertAllowedOrigin(page);
  },

  async inspectTotpChange(page, { control } = {}) {
    checkControl(control);
    const enrollmentSecretVisible = await visible(totpEnrollmentSecret(page));
    const enrollmentDialog = await findTotpEnrollmentDialog(page);
    const enrollmentDialogVisible = Boolean(enrollmentDialog);
    const oneTimeCodeVisible = await visible(oneTimeCode(page));
    const disableChallengeUrl = isTotpDisableChallengeUrl(page);
    const toggleState = await readTotpToggleState(page);
    const disableVisible = await anyVisible(totpDisableLocators(page));
    const enableVisible = await anyVisible(totpEnableLocators(page));
    akDebug("totp_inspect", {
      ...pageDebugMetadata(page),
      enrollment_secret_visible: enrollmentSecretVisible,
      enrollment_dialog_visible: enrollmentDialogVisible,
      one_time_code_visible: oneTimeCodeVisible,
      disable_challenge_url: disableChallengeUrl,
      toggle_state: toggleState,
      disable_visible: disableVisible,
      enable_visible: enableVisible,
    });
    if (enrollmentSecretVisible || enrollmentDialogVisible) {
      return "enrollment";
    }
    if (oneTimeCodeVisible && !disableChallengeUrl) {
      return "enrollment";
    }
    if (toggleState !== null) {
      return toggleState ? "enabled" : "disabled";
    }
    if (disableVisible) {
      return "enabled";
    }
    if (enableVisible) {
      return "disabled";
    }
    throw adapterError("flow_changed");
  },

  async inspectTotpDisable(page, { control } = {}) {
    checkControl(control);
    if (await visible(currentPassword(page))) {
      akDebug("totp_disable_inspect", { ...pageDebugMetadata(page), state: "identity_challenge" });
      return "identity_challenge";
    }
    if (await anyVisible(totpDisableConfirmLocators(page))) {
      akDebug("totp_disable_inspect", { ...pageDebugMetadata(page), state: "confirmation" });
      return "confirmation";
    }
    let authState = "flow_changed";
    try {
      authState = await this.classify(page);
    } catch (error) {
      if (error?.code !== "flow_changed") throw error;
    }
    if (authState === "totp_required" || authState === "totp_rejected") {
      akDebug("totp_disable_inspect", { ...pageDebugMetadata(page), state: authState });
      return authState;
    }
    try {
      const state = await this.inspectTotpChange(page, { control });
      akDebug("totp_disable_inspect", { ...pageDebugMetadata(page), state });
      return state;
    } catch (error) {
      if (error?.code !== "flow_changed") throw error;
    }
    if (authState === "signed_in") {
      akDebug("totp_disable_inspect", { ...pageDebugMetadata(page), state: authState });
      return authState;
    }
    akDebug("totp_disable_inspect", { ...pageDebugMetadata(page), state: "flow_changed" });
    return "flow_changed";
  },

  async beginTotpDisable(page, { control } = {}) {
    if (await anyVisible(totpDisableConfirmLocators(page))) {
      akDebug("totp_disable_begin", { ...pageDebugMetadata(page), initial_state: "confirmation" });
      return page;
    }
    const initialState = await this.inspectTotpChange(page, { control });
    akDebug("totp_disable_begin", { ...pageDebugMetadata(page), initial_state: initialState });
    if (initialState !== "enabled") {
      throw adapterError("flow_changed");
    }
    const disableControl = await firstVisible(totpDisableLocators(page));
    if (disableControl) {
      akDebug("totp_disable_click", { kind: "disable_control" });
      await browserSideEffect(control, () => disableControl.click());
    } else {
      const toggle = await firstVisible(totpToggleLocators(page));
      const checked = toggle ? await readToggleChecked(toggle) : null;
      akDebug("totp_disable_click", { kind: "toggle", present: Boolean(toggle), checked });
      if (!toggle || checked !== true) {
        throw adapterError("flow_changed");
      }
      await browserSideEffect(control, () => toggle.click({ force: true }));
    }
    akDebug("totp_disable_click_complete", pageDebugMetadata(page));
    return waitForTotpDisableSurface(
      page,
      new Set([
        "identity_challenge",
        "totp_required",
        "totp_rejected",
        "confirmation",
        "disabled",
        "enrollment",
      ]),
      15_000,
      control,
    );
  },

  async submitTotpDisableIdentity(page, password, { control } = {}) {
    const state = await this.inspectTotpDisable(page, { control });
    if (state !== "identity_challenge") return page;
    if (typeof password !== "string" || password.length === 0) {
      throw adapterError("flow_changed");
    }
    await this.submitIdentityChallenge(page, password, { control });
    return waitForTotpDisableSurface(
      page,
      new Set([
        "totp_required",
        "totp_rejected",
        "confirmation",
        "signed_in",
        "enabled",
        "disabled",
        "enrollment",
      ]),
      15_000,
      control,
    );
  },

  async submitTotpDisableChallenge(page, code, { control } = {}) {
    const state = await this.inspectTotpDisable(page, { control });
    if (state !== "totp_required" && state !== "totp_rejected") {
      throw adapterError("flow_changed");
    }
    await this.submitTotp(page, code, { control });
    return page;
  },

  async confirmTotpDisable(page, { control } = {}) {
    const state = await this.inspectTotpDisable(page, { control });
    if (state === "disabled" || state === "enrollment") return page;
    if (state !== "confirmation") throw adapterError("flow_changed");
    const confirmation = await firstVisible(totpDisableConfirmLocators(page));
    if (!confirmation) throw adapterError("flow_changed");
    await browserSideEffect(control, () => confirmation.click());
    return waitForTotpDisableSurface(
      page,
      new Set([
        "identity_challenge",
        "totp_required",
        "totp_rejected",
        "signed_in",
        "enabled",
        "disabled",
        "enrollment",
      ]),
      15_000,
      control,
    );
  },

  async openTotpEnrollment(page, { control } = {}) {
    const state = await this.inspectTotpChange(page, { control });
    akDebug("totp_enrollment_open", { ...pageDebugMetadata(page), initial_state: state });
    if (state === "enrollment") return;
    if (state !== "disabled") throw adapterError("flow_changed");
    const enableControl = await firstVisible(totpEnableLocators(page));
    if (enableControl) {
      akDebug("totp_enrollment_click", { kind: "enable_control" });
      await browserSideEffect(control, () => enableControl.click());
    } else {
      const toggle = await firstVisible(totpToggleLocators(page));
      const checked = toggle ? await readToggleChecked(toggle) : null;
      akDebug("totp_enrollment_click", { kind: "toggle", present: Boolean(toggle), checked });
      if (!toggle || checked !== false) {
        throw adapterError("flow_changed");
      }
      await browserSideEffect(control, () => toggle.click({ force: true }));
    }
    akDebug("totp_enrollment_click_complete", pageDebugMetadata(page));
    return waitForTotpEnrollmentSurface(page, 15_000, control);
  },

  async readTotpEnrollment(page, { control } = {}) {
    checkControl(control);
    let secret = await readVisibleTotpEnrollmentSecret(page, false);
    if (!isValidTotpSecret(secret)) {
      const reveal = await firstVisible(totpEnrollmentRevealLocators(page));
      if (reveal) {
        await browserSideEffect(control, () => reveal.click());
        secret = await waitForTotpEnrollmentSecret(page, 5_000, control);
      } else {
        secret = await readVisibleTotpEnrollmentSecret(page);
      }
    }
    if (!isValidTotpSecret(secret)) throw adapterError("flow_changed");
    return secret;
  },

  async submitTotpEnrollment(page, code, { control } = {}) {
    const enrollmentDialog = await findTotpEnrollmentDialog(page);
    const input = enrollmentDialog?.input ?? oneTimeCode(page);
    if (!(await visible(input))) throw adapterError("flow_changed");
    await browserSideEffect(control, () => input.fill(code));
    if (enrollmentDialog?.verify) {
      await browserSideEffect(control, () => enrollmentDialog.verify.click());
      return;
    }
    await clickFirstVisible([
      page.getByRole("button", { name: /^(verify|confirm|enable|continue|xác minh|xác nhận|tiếp tục)$/i }),
      submitControl(page),
    ], control);
  },

  async verifyTotpChanged(page, { control } = {}) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      checkControl(control);
      if (await anyVisible(totpEnrollmentErrorLocators(page))) return false;
      const enrollmentDialog = await findTotpEnrollmentDialog(page);
      if (!enrollmentDialog && !(await visible(oneTimeCode(page)))) {
        if (await anyVisible([
          page.getByRole("status").filter({ hasText: /multi-factor|two-factor|2fa|mfa|authenticator/i }),
          page.getByText(/multi-factor authentication is on|two-factor authentication is on|authenticator.*enabled/i),
          ...totpDisableLocators(page),
        ])) {
          return true;
        }
        if (await readTotpToggleState(page) === true) return true;
      }
      await page.waitForTimeout(100);
    }
    return false;
  },

  async openEmailChange(page, { control } = {}) {
    await openSettingsTarget(page, this, {
      tabLocators: [
        page.locator('[data-testid="account-tab"]'),
        page.getByRole("tab", { name: /^(account|tài khoản)$/i }),
      ],
      targetLocators: [
        page.locator('[data-testid="email-setting"]'),
        page.getByRole("button", { name: /^(email|email address|địa chỉ email)/i }),
      ],
      readyLocators: [emailInput(page)],
      control,
    });
  },

  async submitEmailChange(page, email, { control } = {}) {
    const input = emailInput(page);
    if (!(await visible(input))) throw adapterError("flow_changed");
    await browserSideEffect(control, () => input.fill(email));
    await clickFirstVisible([
      page.getByRole("button", { name: /^(continue|save|update email|change email|tiếp tục|lưu)$/i }),
      submitControl(page),
    ], control);
    await waitForAny(page, [oneTimeCode(page), page.getByText(/check your email|verify.*email/i)], 15_000, control);
  },

  async submitEmailVerification(page, code, { control } = {}) {
    const input = oneTimeCode(page);
    if (!(await visible(input))) throw adapterError("flow_changed");
    await browserSideEffect(control, () => input.fill(code));
    await clickFirstVisible([
      page.getByRole("button", { name: /^(verify|confirm|continue|xác minh|xác nhận|tiếp tục)$/i }),
      submitControl(page),
    ], control);
  },

  async verifyEmailChanged(page, email, { control } = {}) {
    checkControl(control);
    return visible(page.getByText(email, { exact: true }));
  },

  async logout(page, { control } = {}) {
    checkControl(control);
    const state = await this.classify(page);
    checkControl(control);
    if (
      state === "login_ready" ||
      state === "password_change_ready" ||
      state === "password_changed"
    ) {
      return;
    }
    // A post-login billing/renewal interstitial intercepts clicks on the
    // account menu. Dismiss it first so the menu is reachable.
    await dismissBlockingDialog(page, control);
    // Localized menu label (e.g. Vietnamese "Đăng xuất"). Unlike the submit
    // buttons there is no type="submit" fallback for a menu item, so the text
    // matcher must cover the localized rollouts we support.
    const logoutLabel = /^(log ?out|sign ?out|đăng xuất|thoát)$/i;
    const logoutLocators = [
      page.locator('[data-testid="log-out-menu-item"]'),
      page.getByRole("menuitem", { name: logoutLabel }),
      page.getByRole("button", { name: logoutLabel }),
    ];
    let logout = await firstVisible(logoutLocators);
    if (!logout) {
      const menu = await firstVisible(accountMenuLocators(page));
      if (!menu) {
        throw adapterError("flow_changed");
      }
      await browserSideEffect(control, () => menu.click({ force: true }));
      await waitForAny(page, logoutLocators, 5_000, control);
      logout = await firstVisible(logoutLocators);
    }
    if (!logout) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => logout.click());
    // Newer ChatGPT rollouts interpose a confirmation dialog ("Are you sure you
    // want to log out?") between the menu item and the actual sign-out. Without
    // clicking its confirm button the session never ends and the sign-out wait
    // times out. Fold the confirm into the sign-out poll so a late-mounting
    // dialog is still caught and a legacy no-dialog logout adds no latency.
    await waitForSignedOutSurface(page, 15_000, control, () =>
      confirmLogoutDialog(page, control),
    );
  },

  async verifySignedIn(page, { control } = {}) {
    // After a fresh re-login the SPA takes a beat to mount its authenticated
    // shell. A single classify() can race that mount and wrongly report failure
    // even though the new password worked — poll until we see a signed-in
    // surface or a terminal state, rather than trusting one snapshot.
    const deadline = Date.now() + 15_000;
    for (;;) {
      checkControl(control);
      const state = await this.classify(page);
      checkControl(control);
      if (state === "signed_in") {
        return true;
      }
      if (state === "invalid_credentials" || state === "totp_rejected") {
        return false;
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await page.waitForTimeout(100);
    }
  },
};

// Locators that indicate an authenticated ChatGPT shell. Kept broad because the
// signed-in header varies by rollout — the older "profile menu" button, the
// account/data-testid avatar, the composer prompt textarea, and the sidebar
// new-chat control. All of these only render once signed in.
function signedInLocators(page) {
  return [
    page.getByRole("button", { name: /profile|account|user menu/i }),
    page.locator('button[data-testid*="profile"], button[aria-label*="profile" i]'),
    page.locator('[data-testid="profile-button"], [data-testid="accounts-profile-button"]'),
    page.locator('#prompt-textarea, textarea[data-testid="prompt-textarea"]'),
    page.locator('nav[aria-label*="chat" i], nav[aria-label*="history" i]'),
    page.locator('a[data-testid="create-new-chat-button"], nav a[href="/"]'),
  ];
}

function signedOutLocators(page) {
  const label = /^(log ?in|sign ?in|\u0111\u0103ng nh\u1eadp)$/i;
  return [
    page.locator('[data-testid="login-button"]'),
    page.getByRole("button", { name: label }),
    page.getByRole("link", { name: label }),
  ];
}

// Post-login interstitials (e.g. the "Review payment method / Plus renewal
// failed" dialog) only appear after authentication succeeds, but they cover the
// authenticated shell so the normal signed-in locators may not match. Detect
// the dialog so classify() can report signed_in, and so we know to dismiss it
// before driving the account menu.
function blockingDialog(page) {
  return page.getByRole("dialog").filter({
    hasText:
      /payment|billing|renew|subscription|plus|thanh toán|gia hạn|thanh toan/i,
  });
}

function sessionExpiredDialog(page) {
  return page
    .locator('#modal-expired-session, [data-testid="modal-expired-session"]')
    .first();
}

function loginSurfaceLocators(page) {
  return [
    ...authenticationSurfaceLocators(page),
    ...signedOutLocators(page),
    page.getByRole("alert"),
    blockingDialog(page),
    ...signedInLocators(page),
  ];
}

function authenticationSurfaceLocators(page) {
  return [
    emailInput(page),
    currentPassword(page),
    oneTimeCode(page),
    page.locator('iframe[src*="challenges.cloudflare.com"]'),
  ];
}

// Close a post-login interstitial so subsequent menu/logout actions are not
// intercepted by the overlay. Best-effort: try the dialog's close control, then
// Escape. Never throws — a missing dialog is the common case.
async function dismissBlockingDialog(page, control) {
  const dialog = blockingDialog(page);
  if (!(await visible(dialog))) {
    return;
  }
  const closeButton = await firstVisible([
    dialog.getByRole("button", { name: /^(close|dismiss|đóng|not now|later|để sau)$/i }),
    dialog.locator('button[aria-label*="close" i], button[aria-label*="đóng" i]'),
  ]);
  if (closeButton) {
    await browserSideEffect(control, () => closeButton.click());
  } else if (typeof page.keyboard?.press === "function") {
    await browserSideEffect(control, () => page.keyboard.press("Escape"));
  }
  // Give the overlay a moment to tear down before the caller proceeds.
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(200);
  }
  checkControl(control);
}

function accountMenuLocators(page) {
  return [
    page.getByRole("button", { name: /profile|account|user menu/i }),
    page.locator('button[data-testid*="profile"], button[aria-label*="profile" i]'),
    page.locator('[data-testid="profile-button"], [data-testid="accounts-profile-button"]'),
  ];
}

function emailInput(page) {
  return page
    .locator('input[autocomplete="username"], input[autocomplete="email"], input[type="email"]')
    .first();
}

function currentPassword(page) {
  return page
    .locator('input[autocomplete="current-password"], input[type="password"]:not([autocomplete="new-password"])')
    .first();
}

function newPassword(page) {
  return page.locator('input[autocomplete="new-password"]').first();
}

function oneTimeCode(page) {
  return page
    .locator('input[autocomplete="one-time-code"], input[inputmode="numeric"][maxlength="6"]')
    .first();
}

function normalizeTotpSecret(value) {
  return String(value ?? "").replace(/[\s-]+/g, "").toUpperCase();
}

function isValidTotpSecret(value) {
  return /^[A-Z2-7]{16,256}$/.test(value);
}

async function readTotpSecretFromDom(page) {
  if (typeof page.evaluate !== "function") return "";
  return page.evaluate(() => {
    const isVisibleElement = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const visibleDialogs = [...document.querySelectorAll('[role="dialog"]')]
      .filter(isVisibleElement);
    const explicitSelector = '[data-testid="totp-secret"], [data-testid="mfa-secret"], input[readonly][value], code';
    const candidates = visibleDialogs.flatMap((dialog) => [...dialog.querySelectorAll(
      `${explicitSelector}, p, span, div`,
    )])
      .filter(isVisibleElement)
      .map((element) => {
        const inputValue = element instanceof HTMLInputElement ? element.value : "";
        const text = String(inputValue || element.innerText || element.textContent || "").trim();
        const normalized = text.replace(/[\s-]+/g, "").toUpperCase();
        return {
          normalized,
          children: element.childElementCount,
          explicit: element.matches(explicitSelector),
          hasDigit: /[2-7]/.test(normalized),
        };
      })
      .filter(({ normalized, children, explicit, hasDigit }) => (
        /^[A-Z2-7]{16,256}$/.test(normalized)
        && (explicit || (children === 0 && hasDigit))
      ))
      .sort((left, right) => (
        Number(right.explicit) - Number(left.explicit)
        || left.children - right.children
        || left.normalized.length - right.normalized.length
      ));
    return candidates[0]?.normalized ?? "";
  }).catch(() => "");
}

async function readVisibleTotpEnrollmentSecret(page, includeDom = true) {
  const locator = await firstVisible([totpEnrollmentSecret(page)]);
  if (locator) {
    const raw = typeof locator.inputValue === "function"
      ? await locator.inputValue().catch(() => "")
      : "";
    const text = raw || await locator.textContent().catch(() => "");
    const secret = normalizeTotpSecret(text);
    if (isValidTotpSecret(secret)) return secret;
  }
  if (!includeDom) return "";
  const domSecret = normalizeTotpSecret(await readTotpSecretFromDom(page));
  return isValidTotpSecret(domSecret) ? domSecret : "";
}

async function findTotpEnrollmentDialog(page) {
  if (typeof page.getByRole !== "function") return null;
  const dialogs = page.getByRole("dialog");
  if (typeof dialogs?.count !== "function" || typeof dialogs?.nth !== "function") {
    return null;
  }
  const count = await dialogs.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const dialog = dialogs.nth(index);
    if (!(await visible(dialog))) continue;
    const input = dialog.locator(
      'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="text"], input:not([type])',
    ).first();
    const verify = dialog.getByRole("button", {
      name: /^(verify|confirm|enable|continue|xác minh|xác nhận|tiếp tục)$/i,
    }).first();
    if (await visible(input) && await visible(verify)) {
      return { dialog, input, verify };
    }
  }
  return null;
}

function totpEnrollmentSecret(page) {
  return page.locator(
    '[data-testid="totp-secret"], [data-testid="mfa-secret"], input[readonly][value], code',
  ).first();
}

function totpEnrollmentRevealLocators(page) {
  const label = /can(?:not|'t)? scan|trouble.*scan|problem.*scan|manual(?: setup)?|setup key|secret key|bạn gặp vấn đề khi quét/i;
  return [
    page.getByRole("button", { name: label }),
    page.getByRole("link", { name: label }),
  ];
}

function totpEnrollmentErrorLocators(page) {
  const message = /could not verify|unable to verify|invalid (?:verification )?code|incorrect code|code.*(?:invalid|incorrect|expired)|không xác minh được mã|mã không hợp lệ|mã.*(?:không đúng|hết hạn)/i;
  return [
    page.locator('[data-testid="totp-error"], [data-testid="mfa-error"]'),
    page.getByRole("alert").filter({ hasText: message }),
    page.getByText(message),
  ];
}

function isTotpDisableChallengeUrl(page) {
  try {
    const url = new URL(page.url());
    return url.origin === "https://auth.openai.com"
      && url.pathname.startsWith("/mfa-challenge/");
  } catch {
    return false;
  }
}

function totpDisableLocators(page) {
  return [
    page.locator('[data-testid="mfa-disable"], [data-testid="two-factor-disable"]'),
    page.getByRole("button", {
      name: /^(disable|remove|turn off|reset)( multi-factor authentication| two-factor authentication| 2fa| mfa| authenticator( app)?)?$/i,
    }),
  ];
}

function totpDisableConfirmLocators(page) {
  return [
    page.locator('[data-testid="confirm-mfa-disable"], [data-testid="confirm-two-factor-disable"]'),
    page.getByRole("button", {
      name: /^(disable|remove|turn off|confirm|yes,? disable|xóa|xoá)$/i,
    }),
  ];
}

function totpEnableLocators(page) {
  return [
    page.locator('[data-testid="mfa-enable"], [data-testid="two-factor-enable"]'),
    page.getByRole("button", {
      name: /^(enable|add|set up|turn on)( multi-factor authentication| two-factor authentication| 2fa| mfa| authenticator( app)?)?$/i,
    }),
  ];
}

function totpToggleLocators(page) {
  return [
    page.locator('[data-testid="mfa-toggle"], [data-testid="two-factor-toggle"], [data-testid="authenticator-toggle"], [data-testid="mfa-authenticator-toggle"]'),
    page.getByRole("switch", { name: /authenticator app|ứng dụng xác thực/i }),
  ];
}

async function readToggleChecked(locator) {
  if (typeof locator?.isChecked === "function") {
    const checked = await locator.isChecked().catch(() => null);
    if (typeof checked === "boolean") return checked;
  }
  if (typeof locator?.getAttribute === "function") {
    const ariaChecked = await locator.getAttribute("aria-checked").catch(() => null);
    if (ariaChecked === "true") return true;
    if (ariaChecked === "false") return false;
    const dataState = await locator.getAttribute("data-state").catch(() => null);
    if (dataState === "checked" || dataState === "on") return true;
    if (dataState === "unchecked" || dataState === "off") return false;
  }
  return null;
}

async function readTotpToggleState(page) {
  const toggle = await firstVisible(totpToggleLocators(page));
  return toggle ? readToggleChecked(toggle) : null;
}

function totpCandidatePages(page) {
  if (typeof page.context !== "function") return [page];
  const pages = page.context().pages();
  const currentIndex = pages.indexOf(page);
  return currentIndex >= 0 ? pages.slice(currentIndex) : [page];
}

async function waitForTotpDisableSurface(page, expectedStates, timeout, control) {
  const deadline = Date.now() + timeout;
  let lastState = null;
  while (Date.now() < deadline) {
    checkControl(control);
    const pages = totpCandidatePages(page);
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      const candidate = pages[index];
      let origin;
      try {
        origin = new URL(candidate.url()).origin;
      } catch {
        continue;
      }
      if (!ALLOWED_ORIGINS.has(origin)) continue;
      const state = await openaiChatgptAdapter.inspectTotpDisable(candidate, { control });
      if (state !== lastState) {
        akDebug("totp_disable_wait_state", { ...pageDebugMetadata(candidate), state });
        lastState = state;
      }
      if (expectedStates.has(state)) return candidate;
    }
    await page.waitForTimeout(100);
  }
  throw adapterError("flow_changed");
}

async function waitForTotpEnrollmentSurface(page, timeout, control) {
  const deadline = Date.now() + timeout;
  let lastSignature = null;
  while (Date.now() < deadline) {
    checkControl(control);
    const pages = totpCandidatePages(page);
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      const candidate = pages[index];
      let origin;
      try {
        origin = new URL(candidate.url()).origin;
      } catch {
        continue;
      }
      if (!ALLOWED_ORIGINS.has(origin)) continue;
      const secretVisible = await visible(totpEnrollmentSecret(candidate));
      const codeVisible = await visible(oneTimeCode(candidate));
      const dialogVisible = Boolean(await findTotpEnrollmentDialog(candidate));
      const signature = [origin, secretVisible, codeVisible, dialogVisible].join(":");
      if (signature !== lastSignature) {
        akDebug("totp_enrollment_wait_state", {
          ...pageDebugMetadata(candidate),
          secret_visible: secretVisible,
          code_visible: codeVisible,
          dialog_visible: dialogVisible,
        });
        lastSignature = signature;
      }
      if (secretVisible || codeVisible || dialogVisible) {
        return candidate;
      }
    }
    await page.waitForTimeout(100);
  }
  throw adapterError("flow_changed");
}

async function waitForTotpEnrollmentSecret(page, timeout, control) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkControl(control);
    const pages = totpCandidatePages(page);
    for (let index = pages.length - 1; index >= 0; index -= 1) {
      const candidate = pages[index];
      let origin = null;
      try {
        origin = new URL(candidate.url()).origin;
      } catch {
        if (candidate !== page) continue;
      }
      if (origin !== null && !ALLOWED_ORIGINS.has(origin)) continue;
      const secret = await readVisibleTotpEnrollmentSecret(candidate);
      if (isValidTotpSecret(secret)) return secret;
    }
    await page.waitForTimeout(100);
  }
  return "";
}

function totpChangeReadyLocators(page) {
  return [
    ...totpDisableLocators(page),
    ...totpEnableLocators(page),
    ...totpToggleLocators(page),
    totpEnrollmentSecret(page),
    oneTimeCode(page),
  ];
}

async function openSettingsSection(page, adapter, {
  tabLocators,
  control,
}) {
  checkControl(control);
  const authState = await adapter.classify(page);
  akDebug("settings_open_start", { ...pageDebugMetadata(page), auth_state: authState });
  if (authState !== "signed_in") throw adapterError("flow_changed");
  await dismissBlockingDialog(page, control);
  const tabAlreadyVisible = await anyVisible(tabLocators);
  akDebug("settings_tab_probe", { visible: tabAlreadyVisible });
  if (tabAlreadyVisible) {
    await clickFirstVisible(tabLocators, control);
    akDebug("settings_tab_clicked_existing", pageDebugMetadata(page));
    return;
  }
  const settingsLocators = [
    page.locator('[data-testid="settings-menu-item"]'),
    page.getByRole("menuitem", { name: /^(settings|cài đặt)$/i }),
    page.getByRole("button", { name: /^(settings|cài đặt)$/i }),
  ];
  let settings = await firstVisible(settingsLocators);
  akDebug("settings_item_probe", { visible: Boolean(settings) });
  if (!settings) {
    const menu = await firstVisible(accountMenuLocators(page));
    akDebug("settings_menu_probe", { visible: Boolean(menu) });
    if (!menu) throw adapterError("flow_changed");
    await browserSideEffect(control, () => menu.click({ force: true }));
    await waitForAny(page, settingsLocators, 5_000, control);
    settings = await firstVisible(settingsLocators);
  }
  if (!settings) throw adapterError("flow_changed");
  await browserSideEffect(control, () => settings.click());
  akDebug("settings_item_clicked", pageDebugMetadata(page));
  await waitForAny(page, tabLocators, 5_000, control);
  await clickFirstVisible(tabLocators, control);
  akDebug("settings_tab_clicked", pageDebugMetadata(page));
}

async function openSettingsTarget(page, adapter, {
  tabLocators,
  targetLocators,
  readyLocators,
  control,
}) {
  await openSettingsSection(page, adapter, { tabLocators, control });
  await waitForAny(page, targetLocators, 5_000, control);
  await clickFirstVisible(targetLocators, control);
  await waitForAny(page, readyLocators, 15_000, control);
  await adapter.assertAllowedOrigin(page);
}

function submitControl(page) {
  return page.locator('button[type="submit"], input[type="submit"]').first();
}

// The identity-verification screen offers a "forgot password" link that starts
// the reset journey. Its label is localized (e.g. Vietnamese "Bạn quên mật
// khẩu?"), so match on link/button text in several languages and on the reset
// href, not on an anchored English string. Kept broad so a localized rollout
// does not fall through to flow_changed.
function forgotPasswordLocators(page) {
  const label = /forgot.*password|reset.*password|quên mật khẩu|mật khẩu.*quên/i;
  return [
    page.getByRole("link", { name: label }),
    page.getByRole("button", { name: label }),
    page.locator(
      'a[href*="reset-password"], a[href*="forgot-password"], a[href*="password/reset"], a[href*="password-reset"]',
    ).first(),
  ];
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function anyVisible(locators) {
  return (await firstVisible(locators)) !== null;
}

async function firstVisible(locators) {
  for (const locator of locators) {
    const first = locator.first();
    if (await visible(first)) {
      return first;
    }
    if (typeof locator.count !== "function" || typeof locator.nth !== "function") {
      continue;
    }
    const count = await locator.count().catch(() => 0);
    for (let index = 1; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await visible(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function clickFirstVisible(locators, control, onBeforeClick, clickOptions) {
  checkControl(control);
  const locator = await firstVisible(locators);
  checkControl(control);
  if (!locator) {
    throw adapterError("flow_changed");
  }
  await browserSideEffect(control, () => locator.click(clickOptions), onBeforeClick);
}

async function waitForAny(page, locators, timeout, control) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkControl(control);
    if (await anyVisible(locators)) {
      checkControl(control);
      return;
    }
    checkControl(control);
    await page.waitForTimeout(100);
    checkControl(control);
  }
  // Timing out here means the page never reached an expected surface. Returning
  // silently lets the caller skip its next step and the flow driver then
  // misreports the stall as invalid_credentials. Surface it as flow_changed.
  throw adapterError("flow_changed");
}

async function waitForAuthenticationSurface(page, timeout, control) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkControl(control);
    const pages = typeof page.context === "function"
      ? page.context().pages()
      : [page];
    for (const candidate of pages) {
      let origin;
      try {
        origin = new URL(candidate.url()).origin;
      } catch {
        continue;
      }
      if (
        ALLOWED_ORIGINS.has(origin)
        && await anyVisible(authenticationSurfaceLocators(candidate))
      ) {
        checkControl(control);
        return candidate;
      }
    }
    checkControl(control);
    await page.waitForTimeout(100);
    checkControl(control);
  }
  throw adapterError("flow_changed");
}

async function waitForSignedOutSurface(page, timeout, control, onPoll) {
  if (
    typeof page.waitForTimeout !== "function"
    || typeof page.context !== "function"
  ) {
    return;
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkControl(control);
    if (onPoll) {
      await onPoll();
      checkControl(control);
    }
    const pages = page.context().pages();
    for (const candidate of pages) {
      let origin;
      try {
        origin = new URL(candidate.url()).origin;
      } catch {
        continue;
      }
      if (
        ALLOWED_ORIGINS.has(origin)
        && await anyVisible([
          ...authenticationSurfaceLocators(candidate),
          ...signedOutLocators(candidate),
          sessionExpiredDialog(candidate),
        ])
      ) {
        checkControl(control);
        return;
      }
    }
    checkControl(control);
    await page.waitForTimeout(100);
    checkControl(control);
  }
  throw adapterError("flow_changed");
}

// The logout confirmation dialog carries its own "Log out" button (localized,
// e.g. Vietnamese "Đăng xuất"). Scope the match to a dialog/alertdialog so it
// cannot collide with the account-menu item that opened it, and best-effort
// click it. Never throws — the dialog is absent on legacy rollouts.
async function confirmLogoutDialog(page, control) {
  if (typeof page.getByRole !== "function") {
    return;
  }
  const label = /^(log ?out|sign ?out|đăng xuất|thoát)$/i;
  const hasText = /log ?out|sign ?out|đăng xuất|thoát/i;
  const candidates = [];
  for (const role of ["dialog", "alertdialog"]) {
    const dialog = page.getByRole(role);
    if (typeof dialog?.getByRole !== "function") {
      continue;
    }
    const scoped =
      typeof dialog.filter === "function" ? dialog.filter({ hasText }) : dialog;
    const button = scoped.getByRole("button", { name: label });
    if (button) {
      candidates.push(button);
    }
  }
  if (candidates.length === 0) {
    return;
  }
  const confirm = await firstVisible(candidates);
  if (!confirm) {
    return;
  }
  await browserSideEffect(control, () => confirm.click());
}

async function waitUntilHidden(page, locator, timeout, control) {
  const deadline = Date.now() + timeout;
  let hiddenPolls = 0;
  while (Date.now() < deadline) {
    checkControl(control);
    if (await visible(locator)) {
      hiddenPolls = 0;
    } else {
      hiddenPolls += 1;
      if (hiddenPolls >= 2) {
        checkControl(control);
        return;
      }
    }
    checkControl(control);
    await page.waitForTimeout(100);
    checkControl(control);
  }
}

async function browserSideEffect(control, action, onBeforeAction) {
  checkControl(control);
  onBeforeAction?.();
  const result = await action();
  checkControl(control);
  return result;
}

function checkControl(control) {
  control?.throwIfCancelled?.();
}

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
