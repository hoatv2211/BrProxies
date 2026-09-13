import assert from "node:assert/strict";
import test from "node:test";

import { connectAndExportCodex, pairAndExportCurrentSession } from "../codex-oauth.js";

test("pairing exports without managed profiles or API token", async () => {
  const calls = [];
  const nonce = "a".repeat(64);
  const statuses = ["pending", "approved", "pending", "ready"];
  let clock = 0;
  const result = await pairAndExportCurrentSession({nonce, format:"cockpit",
    call: async (path, body) => {
      calls.push(path);
      assert.equal(body.nonce, nonce);
      assert.equal(body.profileIds, undefined);
      if (path === "/bridge/status") return {status:statuses.shift()};
      if (path === "/bridge/oauth") return {authorize_url:"https://auth.openai.com/oauth/authorize"};
      if (path === "/bridge/export") return {exportedCount:1};
      return {status:"pending"};
    },
    openAuthorization: async () => calls.push("open"), sleep:async () => {clock += 1000;}, now:() => clock
  });
  assert.deepEqual(calls, ["/bridge/pair", "/bridge/status", "/bridge/status", "/bridge/oauth", "open", "/bridge/status", "/bridge/status", "/bridge/export"]);
  assert.equal(result.exportedCount, 1);
});

test("denied or timed out pairing never starts OAuth or exports", async () => {
  for (const denied of [true, false]) {
    let clock = 0;
    const calls = [];
    await assert.rejects(pairAndExportCurrentSession({nonce:"a".repeat(64), format:"nine_router",
      call:async (path) => {calls.push(path); return denied ? {status:"failed",error_code:"pairing_denied"} : {status:"pending"};},
      openAuthorization:async () => {throw new Error("must not open");},
      sleep:async () => {clock += 300000;}, now:() => clock
    }), denied ? /pairing_denied/ : /timed_out/);
    assert.ok(!calls.includes("/bridge/oauth") && !calls.includes("/bridge/export"));
  }
});

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

test("runs the current-session guard before starting OAuth", async () => {
  const events = [];
  const profile = {
    profile_id: "profile-current-session",
    codex_auth: { status: "missing" }
  };

  await connectAndExportCodex({
    profileIds: [profile.profile_id],
    format: "nine_router",
    listProfiles: async () => [profile],
    beforeOAuth: async (selectedProfile) => events.push(`guard:${selectedProfile.profile_id}`),
    startOAuth: async () => {
      events.push("start");
      return {
        operation_id: "operation-current-session",
        authorize_url: "https://auth.openai.com/oauth/authorize?synthetic=1",
        expires_in_seconds: 300
      };
    },
    openAuthorization: async () => events.push("open"),
    readOAuth: async () => ({ status: "ready" }),
    exportAccounts: async () => ({ ok: true }),
    sleep: async () => {},
    now: () => 0
  });

  assert.deepEqual(events, [
    "guard:profile-current-session",
    "start",
    "open"
  ]);
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
