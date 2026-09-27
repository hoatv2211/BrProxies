export type CodexConversionDirection =
  | "cockpit_to_nine_router"
  | "nine_router_to_cockpit";

export type CodexFormat = "cockpit" | "nine_router";

export type CodexConversionResult = {
  sourceFormat: CodexFormat;
  targetFormat: CodexFormat;
  accounts: Record<string, unknown>[];
};

const directions = new Set<CodexConversionDirection>([
  "cockpit_to_nine_router",
  "nine_router_to_cockpit",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeJwtPayload(token: unknown): Record<string, unknown> {
  try {
    const payload = String(token).split(".")[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    return asRecord(decoded) ?? {};
  } catch {
    return {};
  }
}

function idTokenMetadata(idToken: unknown) {
  const claims = decodeJwtPayload(idToken);
  const auth = asRecord(claims["https://api.openai.com/auth"]) ?? {};
  return {
    email: nonEmptyString(claims.email),
    accountId: nonEmptyString(auth.chatgpt_account_id),
    planType: nonEmptyString(auth.chatgpt_plan_type),
  };
}

function accessTokenLifetime(
  accessToken: unknown,
  expiresAt: string,
  lastRefreshAt: string,
): number {
  const claims = decodeJwtPayload(accessToken);
  const issuedAt = claims.iat;
  const expires = claims.exp;
  if (typeof issuedAt === "number" && Number.isFinite(issuedAt)
    && typeof expires === "number" && Number.isFinite(expires)) {
    return Math.max(0, Math.trunc(expires - issuedAt));
  }

  const expiresTime = Date.parse(expiresAt);
  const refreshedTime = Date.parse(lastRefreshAt);
  if (Number.isFinite(expiresTime) && Number.isFinite(refreshedTime)) {
    return Math.max(0, Math.trunc((expiresTime - refreshedTime) / 1000));
  }
  return 0;
}

function unwrapAccounts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record && Array.isArray(record.accounts)) return record.accounts;
  if (record) return [record];
  throw new Error("JSON must contain an account object or an accounts array");
}

function accountFormat(account: unknown): CodexFormat | "mixed" | "unknown" {
  const record = asRecord(account);
  if (!record) return "unknown";
  const cockpit = ["access_token", "refresh_token", "id_token", "account_id"]
    .some((key) => key in record);
  const nineRouter = ["accessToken", "refreshToken", "idToken", "providerSpecificData"]
    .some((key) => key in record);
  if (cockpit && nineRouter) return "mixed";
  if (cockpit) return "cockpit";
  if (nineRouter) return "nine_router";
  return "unknown";
}

function requireString(
  account: Record<string, unknown>,
  key: string,
  accountNumber: number,
): string {
  const value = nonEmptyString(account[key]);
  if (!value) throw new Error(`Account ${accountNumber}: missing ${key}`);
  return value;
}

function cockpitToNineRouter(
  account: Record<string, unknown>,
  accountNumber: number,
): Record<string, unknown> {
  const accessToken = requireString(account, "access_token", accountNumber);
  const refreshToken = requireString(account, "refresh_token", accountNumber);
  const idToken = requireString(account, "id_token", accountNumber);
  const metadata = idTokenMetadata(idToken);
  const email = nonEmptyString(account.email)
    ?? metadata.email;
  const accountId = nonEmptyString(account.account_id) ?? metadata.accountId;
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
    name: nonEmptyString(account.account_note) ?? email,
    providerSpecificData: {
      chatgptAccountId: accountId,
      chatgptPlanType: metadata.planType ?? null,
    },
    testStatus: "active",
    isActive: true,
  };
}

function nineRouterToCockpit(
  account: Record<string, unknown>,
  accountNumber: number,
): Record<string, unknown> {
  const accessToken = requireString(account, "accessToken", accountNumber);
  const refreshToken = requireString(account, "refreshToken", accountNumber);
  const idToken = requireString(account, "idToken", accountNumber);
  const metadata = idTokenMetadata(idToken);
  const providerData = asRecord(account.providerSpecificData) ?? {};
  const email = nonEmptyString(account.email)
    ?? metadata.email;
  const accountId = nonEmptyString(providerData.chatgptAccountId) ?? metadata.accountId;

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
    account_note: nonEmptyString(account.name) ?? email,
  };
}

export function convertCodexJson(
  input: string | unknown,
  direction: CodexConversionDirection,
): CodexConversionResult {
  if (!directions.has(direction)) throw new Error("Unsupported conversion direction");

  let parsed: unknown;
  try {
    parsed = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("Invalid JSON");
  }

  const accounts = unwrapAccounts(parsed);
  if (accounts.length === 0) throw new Error("JSON contains no accounts");

  const sourceFormat: CodexFormat = direction === "cockpit_to_nine_router"
    ? "cockpit"
    : "nine_router";
  const formats = accounts.map(accountFormat);
  const invalidIndex = formats.findIndex((format) => format !== sourceFormat);
  if (invalidIndex !== -1) {
    const actual = formats[invalidIndex];
    const hint = actual === "mixed"
      ? "mixed Cockpit and 9Router fields"
      : `${actual} format`;
    throw new Error(
      `Account ${invalidIndex + 1}: expected ${sourceFormat} format, found ${hint}`,
    );
  }

  const converter = direction === "cockpit_to_nine_router"
    ? cockpitToNineRouter
    : nineRouterToCockpit;
  return {
    sourceFormat,
    targetFormat: sourceFormat === "cockpit" ? "nine_router" : "cockpit",
    accounts: accounts.map((account, index) => converter(asRecord(account) ?? {}, index + 1)),
  };
}

export function createConvertedDownload(
  result: CodexConversionResult,
  now = new Date(),
): { filename: string; json: string } {
  if (!result.targetFormat || result.accounts.length === 0) {
    throw new Error("No converted accounts to download");
  }
  const source = result.sourceFormat === "nine_router" ? "9router" : "cockpit";
  const target = result.targetFormat === "nine_router" ? "9router" : "cockpit";
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return {
    filename: `brproxies-codex-${source}-to-${target}-${timestamp}.json`,
    json: `${JSON.stringify(result.accounts, null, 2)}\n`,
  };
}
