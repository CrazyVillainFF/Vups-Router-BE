export const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3.5-lightning:free";
export const DEFAULT_OPENROUTER_MODELS = [
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "cohere/north-mini-code:free",
  "google/gemma-4-31b-it:free"
];
export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export const OPENROUTER_MAX_OUTPUT_TOKENS_DEFAULT = 4096;
export const OPENROUTER_MAX_OUTPUT_TOKENS_LIMIT = 8192;

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

export function openRouterModels() {
  const configured = (process.env.OPENROUTER_MODELS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  const list = configured.length > 0 ? configured : DEFAULT_OPENROUTER_MODELS;
  const ordered = [openRouterModel(), ...list].filter(Boolean);
  return [...new Set(ordered)];
}

export function openRouterMaxOutputTokens() {
  const value = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(value) || value <= 0) return OPENROUTER_MAX_OUTPUT_TOKENS_DEFAULT;
  return Math.min(Math.floor(value), OPENROUTER_MAX_OUTPUT_TOKENS_LIMIT);
}

export async function checkOpenRouter() {
  const models = openRouterModels();
  const configuredDefault = openRouterModel();
  const unavailable = models.map(id => ({ id, name: id, available: false }));
  const key = openRouterApiKey();
  const baseUrl = openRouterBaseUrl();
  if (!key || !baseUrl) return { status: "not_configured", model: configuredDefault, available: false, models: unavailable };

  let response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
    });
  } catch {
    return { status: "unreachable", model: configuredDefault, available: false, models: unavailable };
  }
  if (!response.ok) return { status: "unreachable", model: configuredDefault, available: false, models: unavailable };

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { status: "unreachable", model: configuredDefault, available: false, models: unavailable };
  }
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const byId = new Map(
    entries.filter(entry => typeof entry?.id === "string").map(entry => [entry.id, entry])
  );
  const checked = models.map(id => ({
    id,
    name: typeof byId.get(id)?.name === "string" ? byId.get(id).name : id,
    available: byId.has(id)
  }));
  const ready = checked.filter(model => model.available);
  if (ready.length === 0) {
    return { status: "missing_model", model: configuredDefault, available: false, models: checked };
  }
  const defaultReady = ready.some(model => model.id === configuredDefault);
  return {
    status: "available",
    model: defaultReady ? configuredDefault : ready[0].id,
    available: true,
    models: checked
  };
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
