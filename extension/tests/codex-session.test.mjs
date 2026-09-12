import assert from "node:assert/strict";
import test from "node:test";

import {
  isAllowedChatGPTUrl,
  requireActiveChatGPTTab
} from "../codex-session.js";

test("accepts only secure ChatGPT session URLs", () => {
  assert.equal(isAllowedChatGPTUrl("https://chatgpt.com/"), true);
  assert.equal(isAllowedChatGPTUrl("https://www.chatgpt.com/c/abc"), true);
  assert.equal(isAllowedChatGPTUrl("https://chat.openai.com/"), true);
  assert.equal(isAllowedChatGPTUrl("https://www.chat.openai.com/auth"), true);
  assert.equal(isAllowedChatGPTUrl("http://chatgpt.com/"), false);
  assert.equal(isAllowedChatGPTUrl("https://not-chatgpt.com/"), false);
  assert.equal(isAllowedChatGPTUrl("https://auth.openai.com/oauth/authorize"), false);
});

test("requires an active ChatGPT tab before current-session OAuth", async () => {
  const tab = { id: 7, url: "https://chatgpt.com/" };
  const result = await requireActiveChatGPTTab(async () => [tab]);
  assert.deepEqual(result, tab);
});

test("finds a ChatGPT tab when the export flow tab is focused", async () => {
  const flowTab = { id: 9, url: "chrome-extension://brproxies/codex-flow.html" };
  const chatTab = { id: 10, url: "https://chatgpt.com/" };
  const result = await requireActiveChatGPTTab(async (query) => {
    if (query.active) return [flowTab];
    return [flowTab, chatTab];
  });
  assert.deepEqual(result, chatTab);
});

test("rejects current-session OAuth when the active tab is not ChatGPT", async () => {
  await assert.rejects(
    requireActiveChatGPTTab(async () => [{ id: 8, url: "https://example.test/" }]),
    (error) => error?.message === "chatgpt_session_required"
  );
});
