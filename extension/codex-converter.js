const DIRECTIONS = new Set(["cockpit_to_nine_router", "nine_router_to_cockpit"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeJwtPayload(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

function idTokenMetadata(idToken) {
  const claims = decodeJwtPayload(idToken);
  const auth = claims["https://api.openai.com/auth"] || {};
  return {
    email: nonEmptyString(claims.email),
    accountId: nonEmptyString(auth.chatgpt_account_id),
    planType: nonEmptyString(auth.chatgpt_plan_type)
  };
}

function accessTokenLifetime(accessToken, expiresAt, lastRefreshAt) {
  const claims = decodeJwtPayload(accessToken);
  if (Number.isFinite(claims.iat) && Number.isFinite(claims.exp)) {
    return Math.max(0, Math.trunc(claims.exp - claims.iat));
  }

  const expires = Date.parse(expiresAt);
  const refreshed = Date.parse(lastRefreshAt);
  if (Number.isFinite(expires) && Number.isFinite(refreshed)) {
    return Math.max(0, Math.trunc((expires - refreshed) / 1000));
  }
  return 0;
}

function unwrapAccounts(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.accounts)) {
    return value.accounts;
  }
  if (value && typeof value === "object") return [value];
  throw new Error("JSON must contain an account object or an accounts array");
}

function accountFormat(account) {
  if (!account || typeof account !== "object" || Array.isArray(account)) return "unknown";
  const cockpit = ["access_token", "refresh_token", "id_token", "account_id"].some(
    (key) => key in account
  );
  const nineRouter = ["accessToken", "refreshToken", "idToken", "providerSpecificData"].some(
    (key) => key in account
  );
  if (cockpit && nineRouter) return "mixed";
  if (cockpit) return "cockpit";
  if (nineRouter) return "nine_router";
  return "unknown";
}

function requireString(account, key, accountNumber) {
  const value = nonEmptyString(account[key]);
  if (!value) throw new Error(`Account ${accountNumber}: missing ${key}`);
  return value;
}

function cockpitToNineRouter(account, accountNumber) {
  const accessToken = requireString(account, "access_token", accountNumber);
  const refreshToken = requireString(account, "refresh_token", accountNumber);
  const idToken = requireString(account, "id_token", accountNumber);
  const metadata = idTokenMetadata(idToken);
  const email = nonEmptyString(account.email) || metadata.email;
  const accountId = nonEmptyString(account.account_id) || metadata.accountId;
  const expiresAt = requireString(account, "expired", accountNumber);
  const lastRefreshAt = requireString(account, "last_refresh", accountNumber);

  if (!email) throw new Error(`Account ${accountNumber}: missing email`);
  if (!accountId) throw new Error(`Account ${accountNumber}: missing account_id`);

  return {
    accessToken,
    refreshToken,
    idToken,
    expiresIn: accessTokenLifetime(accessToken, expiresAt, lastRefreshAt),
    expiresAt,
    lastRefreshAt,
    email,
    name: nonEmptyString(account.account_note) || email,
    providerSpecificData: {
      chatgptAccountId: accountId,
      chatgptPlanType: metadata.planType || null
    },
    testStatus: "active",
    isActive: true
  };
}

function nineRouterToCockpit(account, accountNumber) {
  const accessToken = requireString(account, "accessToken", accountNumber);
  const refreshToken = requireString(account, "refreshToken", accountNumber);
  const idToken = requireString(account, "idToken", accountNumber);
  const metadata = idTokenMetadata(idToken);
  const providerData = account.providerSpecificData || {};
  const email = nonEmptyString(account.email) || metadata.email;
  const accountId = nonEmptyString(providerData.chatgptAccountId) || metadata.accountId;

  if (!email) throw new Error(`Account ${accountNumber}: missing email`);
  if (!accountId) {
    throw new Error(`Account ${accountNumber}: missing providerSpecificData.chatgptAccountId`);
  }

  return {
    type: "codex",
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId,
    last_refresh: requireString(account, "lastRefreshAt", accountNumber),
    email,
    expired: requireString(account, "expiresAt", accountNumber),
    account_note: nonEmptyString(account.name) || email
  };
}

export function convertCodexJson(input, direction) {
  if (!DIRECTIONS.has(direction)) throw new Error("Unsupported conversion direction");

  let parsed;
  try {
    parsed = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("Invalid JSON");
  }

  const accounts = unwrapAccounts(parsed);
  if (accounts.length === 0) throw new Error("JSON contains no accounts");

  const expectedSource = direction === "cockpit_to_nine_router" ? "cockpit" : "nine_router";
  const formats = accounts.map(accountFormat);
  const invalidIndex = formats.findIndex((format) => format !== expectedSource);
  if (invalidIndex !== -1) {
    const actual = formats[invalidIndex];
    const hint = actual === "mixed" ? "mixed Cockpit and 9Router fields" : `${actual} format`;
    throw new Error(`Account ${invalidIndex + 1}: expected ${expectedSource} format, found ${hint}`);
  }

  const convert = direction === "cockpit_to_nine_router" ? cockpitToNineRouter : nineRouterToCockpit;
  return {
    sourceFormat: expectedSource,
    targetFormat: expectedSource === "cockpit" ? "nine_router" : "cockpit",
    accounts: accounts.map((account, index) => convert(account, index + 1))
  };
}

export function createConvertedDownload(result, now = new Date()) {
  if (!result?.targetFormat || !Array.isArray(result.accounts) || result.accounts.length === 0) {
    throw new Error("No converted accounts to download");
  }
  const source = result.sourceFormat === "nine_router" ? "9router" : "cockpit";
  const target = result.targetFormat === "nine_router" ? "9router" : "cockpit";
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return {
    filename: `brproxies-codex-${source}-to-${target}-${timestamp}.json`,
    json: `${JSON.stringify(result.accounts, null, 2)}\n`
  };
}
