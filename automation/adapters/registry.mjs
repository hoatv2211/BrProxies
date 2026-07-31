import { fixtureAdapter } from "./fixture-v1.mjs";
import { openaiChatgptAdapter } from "./openai-chatgpt-v1.mjs";

const ADAPTERS = new Map([
  [fixtureAdapter.id, fixtureAdapter],
  [openaiChatgptAdapter.id, openaiChatgptAdapter],
]);

export function getAdapter(id) {
  const adapter = ADAPTERS.get(id);
  if (!adapter) {
    throw new Error(`Unsupported Account Keeper adapter: ${id}`);
  }
  return adapter;
}
