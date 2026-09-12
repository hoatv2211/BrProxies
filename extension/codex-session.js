const CHATGPT_HOSTS = new Set([
  "chatgpt.com",
  "www.chatgpt.com",
  "chat.openai.com",
  "www.chat.openai.com"
]);

export function isAllowedChatGPTUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return CHATGPT_HOSTS.has(url.hostname);
}

export async function requireActiveChatGPTTab(queryTabs) {
  const activeTabs = await queryTabs({ active: true, lastFocusedWindow: true });
  const activeTab = Array.isArray(activeTabs) ? activeTabs[0] : null;
  if (activeTab && isAllowedChatGPTUrl(activeTab.url)) return activeTab;

  const windowTabs = await queryTabs({ lastFocusedWindow: true });
  const chatGPTTab = (Array.isArray(windowTabs) ? windowTabs : []).find((tab) =>
    isAllowedChatGPTUrl(tab?.url)
  );
  if (chatGPTTab) return chatGPTTab;
  throw new Error("chatgpt_session_required");
}
