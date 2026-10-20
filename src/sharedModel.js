import {
  checkOllama,
  ollamaVisionModels,
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
      fallbackModel: check.fallbackModel ?? null,
      defaultUnavailable: check.defaultUnavailable === true,
      freeOnly: check.freeOnly === true,
      catalogStale: check.catalogStale === true,
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
    fallbackModel: null,
    defaultUnavailable: false,
    freeOnly: true,
    catalogStale: false,
    models: [{ id: check.model, name: check.model, available: check.available, vision: ollamaVisionModels().has(check.model) }]
  };
}

export function sharedProviderForChat() {
  if (openRouterConfigured()) return openRouterProviderForChat();
  return ollamaProviderForChat();
}

export { sharedModelName, openRouterModel };
