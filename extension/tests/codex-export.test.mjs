import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexDownload,
  isCodexExportable,
  normalizeLoopbackApiUrl
} from "../codex-export.js";

test("normalizes only loopback BrProxies API URLs", () => {
  assert.equal(
    normalizeLoopbackApiUrl("http://localhost:40325/path?q=1", "http://127.0.0.1:40325"),
    "http://localhost:40325"
  );
  assert.throws(
    () => normalizeLoopbackApiUrl("https://example.com", "http://127.0.0.1:40325"),
    /127\.0\.0\.1/
  );
});

test("exports only profiles that already have a Codex credential", () => {
  assert.equal(isCodexExportable({ codex_auth: { status: "ready" } }), true);
  assert.equal(isCodexExportable({ codex_auth: { status: "reconnect_required" } }), true);
  assert.equal(isCodexExportable({ codex_auth: { status: "missing" } }), false);
});

test("builds target-specific JSON downloads", () => {
  const account = { accessToken: "synthetic-access", email: "owner@example.test" };
  const download = createCodexDownload(
    "nine_router",
    [account],
    new Date("2026-09-12T08:00:00Z")
  );
  assert.match(download.filename, /^brproxies-codex-9router-/);
  assert.deepEqual(JSON.parse(download.json), [account]);
});

test("rejects empty and unknown exports", () => {
  assert.throws(() => createCodexDownload("cockpit", []), /No Codex accounts/);
  assert.throws(() => createCodexDownload("other", [{}]), /Unsupported/);
});
