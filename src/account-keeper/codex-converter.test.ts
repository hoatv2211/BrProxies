import { describe, expect, it } from "vitest";
import { convertCodexJson, createConvertedDownload } from "./codex-converter";

function jwt(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `synthetic-header.${payload}.synthetic-signature`;
}

const accessToken = jwt({ iat: 100, exp: 3700 });
const idToken = jwt({
  email: "owner@example.test",
  "https://api.openai.com/auth": {
    chatgpt_account_id: "account-synthetic-001",
    chatgpt_plan_type: "team",
  },
});

const cockpitAccount = {
  type: "codex",
  id_token: idToken,
  access_token: accessToken,
  refresh_token: "synthetic-refresh-token",
  account_id: "account-synthetic-001",
  last_refresh: "2026-09-12T00:00:00.000Z",
  expired: "2026-09-12T01:00:00.000Z",
  email: "owner@example.test",
  account_note: "Synthetic owner",
};

const nineRouterAccount = {
  accessToken,
  refreshToken: "synthetic-refresh-token",
  idToken,
  expiresIn: 3600,
  expiresAt: "2026-09-12T01:00:00.000Z",
  lastRefreshAt: "2026-09-12T00:00:00.000Z",
  email: "owner@example.test",
  name: "Synthetic owner",
  providerSpecificData: {
    chatgptAccountId: "account-synthetic-001",
    chatgptPlanType: "team",
  },
  testStatus: "active",
  isActive: true,
};

describe("Codex JSON converter", () => {
  it("converts a Cockpit accounts wrapper to a 9Router account array", () => {
    const result = convertCodexJson(
      JSON.stringify({ accounts: [cockpitAccount] }),
      "cockpit_to_nine_router",
    );

    expect(result).toEqual({
      sourceFormat: "cockpit",
      targetFormat: "nine_router",
      accounts: [nineRouterAccount],
    });
  });

  it("converts a single 9Router object to Cockpit", () => {
    const result = convertCodexJson(nineRouterAccount, "nine_router_to_cockpit");

    expect(result.sourceFormat).toBe("nine_router");
    expect(result.targetFormat).toBe("cockpit");
    expect(result.accounts).toEqual([cockpitAccount]);
  });

  it("rejects invalid, empty, mixed, and wrong-direction input", () => {
    expect(() => convertCodexJson("not-json", "cockpit_to_nine_router"))
      .toThrow("Invalid JSON");
    expect(() => convertCodexJson([], "cockpit_to_nine_router"))
      .toThrow("JSON contains no accounts");
    expect(() => convertCodexJson({ ...cockpitAccount, accessToken }, "cockpit_to_nine_router"))
      .toThrow("mixed Cockpit and 9Router fields");
    expect(() => convertCodexJson(nineRouterAccount, "cockpit_to_nine_router"))
      .toThrow("expected cockpit format");
  });

  it("creates a raw account-array download with a deterministic filename", () => {
    const result = convertCodexJson(cockpitAccount, "cockpit_to_nine_router");
    const download = createConvertedDownload(result, new Date("2026-09-12T04:05:06.007Z"));

    expect(download.filename).toBe(
      "brproxies-codex-cockpit-to-9router-2026-09-12T04-05-06-007Z.json",
    );
    expect(JSON.parse(download.json)).toEqual([nineRouterAccount]);
  });
});
