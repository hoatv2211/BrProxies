const PHASE_COMMANDS = new Set([
  "resume",
  "totp_code",
  "totp_enrollment_code",
  "email_verification_code",
]);

export class CommandControl {
  constructor(requestId) {
    this.requestId = requestId;
    this.cancelled = false;
    this.cancelMessage = null;
    this.waiter = null;
  }

  push(message) {
    if (!message || message.request_id !== this.requestId) {
      return false;
    }
    if (message.type === "cancel") {
      if (this.cancelled) {
        return false;
      }
      this.cancelled = true;
      this.cancelMessage = message;
      if (this.waiter) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(message);
      }
      return true;
    }
    if (
      this.cancelled ||
      !this.waiter ||
      !this.waiter.expectedTypes.has(message.type)
    ) {
      return false;
    }
    const { resolve } = this.waiter;
    this.waiter = null;
    resolve(message);
    return true;
  }

  waitFor(expectedType) {
    return this.waitForAny([expectedType]);
  }

  waitForAny(expectedTypes) {
    const allowed = new Set(expectedTypes);
    if (
      allowed.size === 0 ||
      [...allowed].some((type) => !PHASE_COMMANDS.has(type)) ||
      this.waiter
    ) {
      return Promise.reject(codedError("protocol_error"));
    }
    if (this.cancelled) {
      return Promise.resolve(this.cancelMessage);
    }
    return new Promise((resolve) => {
      this.waiter = { expectedTypes: allowed, resolve };
    });
  }

  throwIfCancelled() {
    if (this.cancelled) {
      throw codedError("cancelled");
    }
  }
}

export async function createControlledPageSession(context, allowedOrigins) {
  const origins = normalizeOrigins(allowedOrigins);
  const tracked = new WeakSet();
  let dedicatedPage = null;
  let currentPage = null;

  const consider = (page) => {
    let origin;
    try {
      origin = new URL(page.url()).origin;
    } catch {
      return;
    }
    if (origins.has(origin)) {
      const activePopup =
        currentPage &&
        currentPage !== dedicatedPage &&
        !currentPage.isClosed?.();
      if (page === dedicatedPage && activePopup) {
        return;
      }
      currentPage = page;
    } else if (currentPage === page && dedicatedPage && page !== dedicatedPage) {
      currentPage = dedicatedPage;
    }
  };

  const track = (page) => {
    if (!page || tracked.has(page)) {
      return;
    }
    tracked.add(page);
    page.on?.("framenavigated", () => consider(page));
    page.on?.("load", () => consider(page));
    page.on?.("close", () => {
      if (currentPage === page) {
        currentPage = dedicatedPage;
      }
    });
    consider(page);
  };

  context.on?.("page", track);
  dedicatedPage = await context.newPage();
  currentPage = dedicatedPage;
  track(dedicatedPage);

  return {
    async current() {
      const pages = typeof context.pages === "function" ? context.pages() : [];
      const dedicatedIndex = pages.indexOf(dedicatedPage);
      for (let index = pages.length - 1; index > dedicatedIndex; index -= 1) {
        const candidate = pages[index];
        if (!candidate || candidate.isClosed?.()) {
          continue;
        }
        let origin;
        try {
          origin = new URL(candidate.url()).origin;
        } catch {
          continue;
        }
        if (origins.has(origin)) {
          track(candidate);
          currentPage = candidate;
          break;
        }
      }
      if (currentPage?.isClosed?.()) {
        currentPage = dedicatedPage;
      }
      if (!currentPage || currentPage.isClosed?.()) {
        throw codedError("browser_crashed");
      }
      return currentPage;
    },
    adopt(page) {
      if (!page || page.isClosed?.()) {
        throw codedError("browser_crashed");
      }
      let origin;
      try {
        origin = new URL(page.url()).origin;
      } catch {
        throw codedError("flow_changed");
      }
      if (!origins.has(origin)) {
        throw codedError("flow_changed");
      }
      track(page);
      currentPage = page;
    },
    dispose() {
      context.off?.("page", track);
    },
  };
}

export function validateCdpEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw codedError("protocol_error");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw codedError("protocol_error");
  }
  return url.toString();
}

export function validateCodexOAuthUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw codedError("protocol_error");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "auth.openai.com" ||
    url.port !== "" ||
    url.pathname !== "/oauth/authorize" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !url.searchParams.get("client_id") ||
    !url.searchParams.get("state")
  ) throw codedError("protocol_error");
  return url.toString();
}

function normalizeOrigins(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw codedError("protocol_error");
  }
  const origins = new Set();
  for (const value of values) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw codedError("protocol_error");
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw codedError("protocol_error");
    }
    origins.add(url.origin);
  }
  return origins;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
