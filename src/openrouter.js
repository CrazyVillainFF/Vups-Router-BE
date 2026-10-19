export const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3.5-lightning:free";
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

const MODELS_TIMEOUT_MS = 10000;

export function openRouterApiKey() {
  const key = (process.env.OPENROUTER_API_KEY || "").trim();
  return key || null;
}

export function openRouterConfigured() {
  return Boolean(openRouterApiKey() && openRouterBaseUrl());
}

export function openRouterBaseUrl() {
  const raw = (process.env.OPENROUTER_BASE_URL || "").trim() || OPENROUTER_API_BASE;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

export function openRouterModel() {
  const model = (process.env.OPENROUTER_MODEL || "").trim();
  return model || DEFAULT_OPENROUTER_MODEL;
}

export function openRouterMaxOutputTokens() {
  const value = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1024;
}

export async function checkOpenRouter() {
  const model = openRouterModel();
  const key = openRouterApiKey();
  const baseUrl = openRouterBaseUrl();
  if (!key || !baseUrl) return { status: "not_configured", model, available: false };

  let response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
    });
  } catch {
    return { status: "unreachable", model, available: false };
  }
  if (!response.ok) return { status: "unreachable", model, available: false };

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { status: "unreachable", model, available: false };
  }
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const installed = entries.some(entry => entry?.id === model);
  return { status: installed ? "available" : "missing_model", model, available: installed };
}

export function openRouterProviderForChat() {
  const key = openRouterApiKey();
  const baseUrl = openRouterBaseUrl();
  if (!key || !baseUrl) return null;
  return {
    provider: "OpenRouter",
    baseUrl,
    apiKey: key,
    defaultModel: openRouterModel(),
    maxTokens: openRouterMaxOutputTokens()
  };
}
