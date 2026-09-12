import assert from "node:assert/strict";
import test from "node:test";

import { connectAndExportCodex } from "../codex-oauth.js";

const readyProfile = {
  profile_id: "profile-ready",
  masked_account: "r***y@example.test",
  codex_auth: { status: "ready" }
};

test("ready Codex profiles export without opening OAuth", async () => {
  let oauthStarts = 0;
  let opened = 0;
  const result = await connectAndExportCodex({
    profileIds: [readyProfile.profile_id],
    format: "nine_router",
    listProfiles: async () => [readyProfile],
    startOAuth: async () => { oauthStarts += 1; },
    openAuthorization: async () => { opened += 1; },
    readOAuth: async () => ({ status: "ready" }),
    exportAccounts: async (profileIds, format) => ({ profileIds, format })
  });

  assert.equal(oauthStarts, 0);
  assert.equal(opened, 0);
  assert.deepEqual(result, {
    profileIds: [readyProfile.profile_id],
    format: "nine_router"
  });
});

test("missing credential opens OAuth and exports after callback is ready", async () => {
  const profile = {
    profile_id: "profile-missing",
    masked_account: "m***g@example.test",
    codex_auth: { status: "missing" }
  };
  const opened = [];
  const statuses = [{ status: "pending" }, { status: "ready" }];
  let clock = 0;
  const result = await connectAndExportCodex({
    profileIds: [profile.profile_id],
    format: "cockpit",
    listProfiles: async () => [profile],
    startOAuth: async (profileId) => ({
      operation_id: `operation-${profileId}`,
      authorize_url: "https://auth.openai.com/oauth/authorize?synthetic=1",
      expires_in_seconds: 300
    }),
    openAuthorization: async (url) => opened.push(url),
    readOAuth: async () => statuses.shift(),
    exportAccounts: async (profileIds, format) => ({ profileIds, format }),
    sleep: async (milliseconds) => { clock += milliseconds; },
    now: () => clock,
    pollIntervalMs: 10
  });

  assert.deepEqual(opened, ["https://auth.openai.com/oauth/authorize?synthetic=1"]);
  assert.deepEqual(result, {
    profileIds: [profile.profile_id],
    format: "cockpit"
  });
});

test("failed OAuth stops before secret-bearing export", async () => {
  const profile = {
    profile_id: "profile-reconnect",
    codex_auth: { status: "reconnect_required" }
  };
  let exported = false;
  await assert.rejects(
    connectAndExportCodex({
      profileIds: [profile.profile_id],
      format: "nine_router",
      listProfiles: async () => [profile],
      startOAuth: async () => ({
        operation_id: "operation-failed",
        authorize_url: "https://auth.openai.com/oauth/authorize?synthetic=1",
        expires_in_seconds: 300
      }),
      openAuthorization: async () => {},
      readOAuth: async () => ({ status: "failed", error_code: "codex_oauth_failed" }),
      exportAccounts: async () => { exported = true; },
      sleep: async () => {},
      now: () => 0
    }),
    /codex_oauth_failed/
  );
  assert.equal(exported, false);
});
