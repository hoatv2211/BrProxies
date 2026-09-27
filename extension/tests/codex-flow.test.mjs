import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const flowPath = path.resolve(import.meta.dirname, "..", "codex-flow.js");
const flowSource = fs.readFileSync(flowPath, "utf8");

test("Codex flow forwards current-session mode and explains missing ChatGPT session", () => {
  assert.match(flowSource, /useCurrentSession/);
  assert.match(flowSource, /chatgpt_session_required/);
});
