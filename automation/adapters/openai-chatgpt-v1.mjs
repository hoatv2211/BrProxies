const ALLOWED_ORIGINS = new Set(["https://auth.openai.com", "https://chatgpt.com"]);
const LOGIN_URL = "https://chatgpt.com/auth/login";

export const openaiChatgptAdapter = {
  id: "openai-chatgpt-v1",
  allowedOrigins: [...ALLOWED_ORIGINS],
  loginUrl: LOGIN_URL,

  async assertAllowedOrigin(page) {
    const origin = new URL(page.url()).origin;
    if (!ALLOWED_ORIGINS.has(origin)) {
      throw adapterError("flow_changed");
    }
  },

  async openLogin(page, { control } = {}) {
    await browserSideEffect(control, () =>
      page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }),
    );
    await this.assertAllowedOrigin(page);
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

    if (await anyVisible([
      page.getByRole("heading", { name: /verify|security check|unusual activity/i }),
      page.getByRole("alert").filter({ hasText: /verify|security check|unusual activity/i }),
    ])) {
      return { state: "manual_required", reason: "security_challenge", url };
    }

    if (await visible(oneTimeCode(page))) {
      return "totp_required";
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
      page.getByRole("alert").filter({ hasText: /incorrect|invalid|wrong password/i }),
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

    const current = new URL(url);
    const signedInSignal = await anyVisible([
      page.getByRole("button", { name: /profile|account|user menu/i }),
      page.locator('button[data-testid*="profile"], button[aria-label*="profile" i]'),
    ]);
    if (
      current.origin === "https://chatgpt.com" &&
      !current.pathname.startsWith("/auth") &&
      signedInSignal
    ) {
      return "signed_in";
    }
    return "flow_changed";
  },

  async submitCredentials(page, { account, password }, { control } = {}) {
    const email = emailInput(page);
    if (await visible(email)) {
      await browserSideEffect(control, () => email.fill(account));
      await clickFirstVisible([
        page.getByRole("button", { name: /^(continue|next)$/i }),
        page.getByRole("button", { name: /^(log in|sign in)$/i }),
      ], control);
      await waitForAny(
        page,
        [currentPassword(page), oneTimeCode(page)],
        15_000,
        control,
      );
    }

    const passwordInput = currentPassword(page);
    if (await visible(passwordInput)) {
      await browserSideEffect(control, () => passwordInput.fill(password));
      await clickFirstVisible([
        page.getByRole("button", { name: /^(continue|log in|sign in)$/i }),
      ], control);
    }
  },

  async submitTotp(page, code, { control } = {}) {
    const input = oneTimeCode(page);
    if (!(await visible(input))) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => input.fill(code));
    await clickFirstVisible([
      page.getByRole("button", { name: /^(continue|verify|submit)$/i }),
    ], control);
  },

  async openPasswordChange(page, { account, control }) {
    await this.logout(page, { control });
    await this.openLogin(page, { control });
    const email = emailInput(page);
    if (!(await visible(email))) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => email.fill(account));
    await clickFirstVisible([
      page.getByRole("button", { name: /^(continue|next)$/i }),
    ], control);
    await waitForAny(page, [currentPassword(page)], 15_000, control);
    await clickFirstVisible([
      page.getByRole("link", { name: /^forgot password\??$/i }),
      page.getByRole("button", { name: /^forgot password\??$/i }),
    ], control);
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
    ], control, onBeforeSubmit);
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
    const menu = await firstVisible([
      page.getByRole("button", { name: /profile|account|user menu/i }),
    ]);
    if (!menu) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => menu.click());
    const logout = await firstVisible([
      page.getByRole("menuitem", { name: /^(log out|sign out)$/i }),
      page.getByRole("button", { name: /^(log out|sign out)$/i }),
    ]);
    if (!logout) {
      throw adapterError("flow_changed");
    }
    await browserSideEffect(control, () => logout.click());
  },

  async verifySignedIn(page, { control } = {}) {
    checkControl(control);
    const state = await this.classify(page);
    checkControl(control);
    return state === "signed_in";
  },
};

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

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function anyVisible(locators) {
  return (await firstVisible(locators)) !== null;
}

async function firstVisible(locators) {
  for (const locator of locators) {
    if (await visible(locator.first())) {
      return locator.first();
    }
  }
  return null;
}

async function clickFirstVisible(locators, control, onBeforeClick) {
  checkControl(control);
  const locator = await firstVisible(locators);
  checkControl(control);
  if (!locator) {
    throw adapterError("flow_changed");
  }
  await browserSideEffect(control, () => locator.click(), onBeforeClick);
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
