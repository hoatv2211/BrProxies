import assert from "node:assert/strict";
import test from "node:test";

import { registerAccountKeeperTools } from "./account-keeper-tools.js";

function fakeZod() {
  const optional = (kind) => ({ kind, optional: () => ({ kind, optional: true }) });
  return {
    string: () => optional("string"),
    boolean: () => optional("boolean"),
    literal: (value) => ({ kind: "literal", value }),
  };
}

function fakeServer() {
  const tools = new Map();
  return {
    tools,
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
  };
}

const asText = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

test("registers redacted Account Keeper job controls", async () => {
  const calls = [];
  const server = fakeServer();
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    return {
      id: "job-1",
      status: "queued",
      batch_id: null,
      stage: null,
      error_code: null,
      account_count: 1,
      has_last_verified_at: false,
      created_at: "100",
      updated_at: "100",
      input_path: "C:/secret/input.txt",
      password: "must-not-leak",
      totp_secret: "must-not-leak",
    };
  };

  registerAccountKeeperTools(server, { api, text: asText, z: fakeZod() });

  assert.deepEqual([...server.tools.keys()], [
    "account_keeper_create_job",
    "account_keeper_list_jobs",
    "account_keeper_get_job",
    "account_keeper_continue_job",
    "account_keeper_resume_job",
    "account_keeper_cancel_job",
  ]);
  assert.deepEqual(
    server.tools.get("account_keeper_create_job").schema.authorize_password_change,
    { kind: "literal", value: true },
  );

  const result = await server.tools.get("account_keeper_create_job").handler({
    input_path: "C:/local/account-keeper-input.txt",
    output_path: "C:/local/account-keeper-result.json",
    template: "Local-{random:16}",
    keep_profile_running: true,
    authorize_password_change: true,
  });

  assert.deepEqual(calls, [{
    path: "/account-keeper/jobs",
    options: {
      method: "POST",
      body: {
        input_path: "C:/local/account-keeper-input.txt",
        output_path: "C:/local/account-keeper-result.json",
        template: "Local-{random:16}",
        keep_profile_running: true,
        authorize_password_change: true,
      },
    },
  }]);
  assert.equal(result.content[0].text.includes("must-not-leak"), false);
  assert.equal(result.content[0].text.includes("C:/secret/input.txt"), false);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    id: "job-1",
    status: "queued",
    batch_id: null,
    stage: null,
    error_code: null,
    account_count: 1,
    has_last_verified_at: false,
    created_at: "100",
    updated_at: "100",
  });
});
