const PHASE_COMMANDS = new Set(["resume", "totp_code"]);

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
      this.waiter.expectedType !== message.type
    ) {
      return false;
    }
    const { resolve } = this.waiter;
    this.waiter = null;
    resolve(message);
    return true;
  }

  waitFor(expectedType) {
    if (!PHASE_COMMANDS.has(expectedType) || this.waiter) {
      return Promise.reject(codedError("protocol_error"));
    }
    if (this.cancelled) {
      return Promise.resolve(this.cancelMessage);
    }
    return new Promise((resolve) => {
      this.waiter = { expectedType, resolve };
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
      if (currentPage?.isClosed?.()) {
        currentPage = dedicatedPage;
      }
      if (!currentPage || currentPage.isClosed?.()) {
        throw codedError("browser_crashed");
      }
      return currentPage;
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
