import {
  checkOllama,
  sharedModelEnabled,
  sharedModelName,
  sharedProviderForChat as ollamaProviderForChat
} from "./ollama.js";
import { checkOpenRouter, openRouterConfigured, openRouterModel, openRouterProviderForChat } from "./openrouter.js";

export { setSharedModelEnabled } from "./ollama.js";

export const SHARED_OWNER_LABEL = "Shared · Free · No API key needed";

export async function sharedModelStatus() {
  const enabled = await sharedModelEnabled();
  if (openRouterConfigured()) {
    const check = await checkOpenRouter();
    return {
      enabled,
      provider: "openrouter",
      model: check.model,
      available: enabled && check.available,
      status: enabled ? check.status : "disabled",
      models: check.models ?? []
    };
  }
  const check = await checkOllama();
  return {
    enabled,
    provider: "ollama",
    model: check.model,
    available: enabled && check.available,
    status: enabled ? check.status : "disabled",
    models: [{ id: check.model, name: check.model, available: check.available }]
  };
}

export function sharedProviderForChat() {
  if (openRouterConfigured()) return openRouterProviderForChat();
  return ollamaProviderForChat();
}

export { sharedModelName, openRouterModel };
