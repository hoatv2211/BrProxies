import assert from "node:assert/strict";
import test from "node:test";

import { convertCodexJson, createConvertedDownload } from "../codex-converter.js";

function syntheticJwt(payload) {
  return `synthetic-header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.synthetic-signature`;
}

const idToken = syntheticJwt({
  email: "owner@example.test",
  "https://api.openai.com/auth": {
    chatgpt_account_id: "synthetic-account-id",
    chatgpt_plan_type: "plus"
  }
});
const accessToken = syntheticJwt({ iat: 1_800_000_000, exp: 1_800_864_000 });

test("uses token identity, never display labels as email in either direction", () => {
  const cockpit = { type: "codex", access_token: accessToken, refresh_token: "synthetic-refresh",
    id_token: idToken, account_id: "synthetic-account-id", account_note: "Display label",
    expired: "2027-01-25T08:00:00Z", last_refresh: "2027-01-15T08:00:00Z" };
  const converted = convertCodexJson(cockpit, "cockpit_to_nine_router").accounts[0];
  assert.equal(converted.email, "owner@example.test");
  assert.equal(converted.name, "Display label");
  const nine = { ...converted, email: undefined };
  assert.equal(convertCodexJson(nine, "nine_router_to_cockpit").accounts[0].email, "owner@example.test");
  assert.throws(() => convertCodexJson({ ...cockpit, id_token: syntheticJwt({}) }, "cockpit_to_nine_router"), /missing email/);
  assert.throws(() => convertCodexJson({ ...nine, idToken: syntheticJwt({}) }, "nine_router_to_cockpit"), /missing email/);
});

test("converts Cockpit accounts to exact 9Router fields", () => {
  const result = convertCodexJson(
    JSON.stringify([
      {
        type: "codex",
        id_token: idToken,
        access_token: accessToken,
        refresh_token: "synthetic-refresh",
        account_id: "synthetic-account-id",
        last_refresh: "2027-01-15T08:00:00Z",
        email: "owner@example.test",
        expired: "2027-01-25T08:00:00Z",
        account_note: "Primary account"
      }
    ]),
    "cockpit_to_nine_router"
  );

  assert.equal(result.sourceFormat, "cockpit");
  assert.equal(result.targetFormat, "nine_router");
  assert.deepEqual(result.accounts[0], {
    accessToken,
    refreshToken: "synthetic-refresh",
    idToken,
    expiresIn: 864_000,
    expiresAt: "2027-01-25T08:00:00Z",
    lastRefreshAt: "2027-01-15T08:00:00Z",
    email: "owner@example.test",
    name: "Primary account",
    providerSpecificData: {
      chatgptAccountId: "synthetic-account-id",
      chatgptPlanType: "plus"
    },
    testStatus: "active",
    isActive: true
  });
});

test("converts 9Router account wrappers to exact Cockpit fields", () => {
  const result = convertCodexJson(
    {
      accounts: [
        {
          accessToken,
          refreshToken: "synthetic-refresh",
          idToken,
          expiresIn: 864_000,
          expiresAt: "2027-01-25T08:00:00Z",
          lastRefreshAt: "2027-01-15T08:00:00Z",
          email: "owner@example.test",
          name: "Primary account",
          providerSpecificData: {
            chatgptAccountId: "synthetic-account-id",
            chatgptPlanType: "plus"
          },
          testStatus: "active",
          isActive: true
        }
      ]
    },
    "nine_router_to_cockpit"
  );

  assert.deepEqual(result.accounts[0], {
    type: "codex",
    id_token: idToken,
    access_token: accessToken,
    refresh_token: "synthetic-refresh",
    account_id: "synthetic-account-id",
    last_refresh: "2027-01-15T08:00:00Z",
    email: "owner@example.test",
    expired: "2027-01-25T08:00:00Z",
    account_note: "Primary account"
  });
});

test("creates a directional download without wrapping the account array", () => {
  const result = convertCodexJson(
    {
      accessToken,
      refreshToken: "synthetic-refresh",
      idToken,
      expiresAt: "2027-01-25T08:00:00Z",
      lastRefreshAt: "2027-01-15T08:00:00Z",
      email: "owner@example.test",
      providerSpecificData: { chatgptAccountId: "synthetic-account-id" }
    },
    "nine_router_to_cockpit"
  );
  const download = createConvertedDownload(result, new Date("2026-09-12T09:00:00Z"));

  assert.match(download.filename, /^brproxies-codex-9router-to-cockpit-/);
  assert.ok(Array.isArray(JSON.parse(download.json)));
});

test("rejects wrong directions, mixed schemas, and incomplete accounts", () => {
  assert.throws(
    () => convertCodexJson({ access_token: "synthetic" }, "nine_router_to_cockpit"),
    /expected nine_router/
  );
  assert.throws(
    () =>
      convertCodexJson(
        { access_token: "synthetic", accessToken: "synthetic" },
        "cockpit_to_nine_router"
      ),
    /mixed Cockpit and 9Router fields/
  );
  assert.throws(
    () => convertCodexJson({ access_token: "synthetic" }, "cockpit_to_nine_router"),
    /missing refresh_token/
  );
  assert.throws(() => convertCodexJson("not json", "cockpit_to_nine_router"), /Invalid JSON/);
});
