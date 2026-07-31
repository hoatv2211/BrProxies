const ALLOWED_ORIGINS = new Set(["https://auth.openai.com", "https://chatgpt.com"]);
const APP_URL = "https://chatgpt.com/";
const LOGIN_URL = "https://chatgpt.com/auth/login";

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
      await browserSideEffect(control, () => email.fill(account));
      await clickFirstVisible([
        page.getByRole("button", { name: /^(continue|next|tiếp tục)$/i }),
        page.getByRole("button", { name: /^(log in|sign in|đăng nhập)$/i }),
        submitControl(page),
      ], control);
      return false;
    }

    const passwordInput = currentPassword(page);
    if (await visible(passwordInput)) {
      await browserSideEffect(control, () => passwordInput.fill(password));
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
    if (count === 0) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => inputs.nth(0).fill(value));
    if (count > 1) {
      await browserSideEffect(control, () => inputs.nth(1).fill(value));
    }
    await clickFirstVisible([
      page.getByRole("button", { name: /^(continue|reset password|update password|save)$/i }),
      submitControl(page),
    ], control, onBeforeSubmit);
    await waitUntilHidden(page, newPassword(page), 15_000, control);
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
    await waitForSignedOutSurface(page, 15_000, control);
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

async function waitForSignedOutSurface(page, timeout, control) {
  if (
    typeof page.waitForTimeout !== "function"
    || typeof page.context !== "function"
  ) {
    return;
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    checkControl(control);
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
