import AppSetting from "./appSetting.js";

export const SHARED_SETTING_KEY = "sharedOllamaEnabled";
export const SHARED_PROVIDER_LABEL = "VupsRouter Shared";
export const SHARED_OWNER_LABEL = "Shared · Free · No API key needed";
export const DEFAULT_SHARED_MODEL = "gemma3:4b";

const TAGS_TIMEOUT_MS = 5000;

export function sharedModelName() {
  const model = (process.env.OLLAMA_MODEL || "").trim();
  return model || DEFAULT_SHARED_MODEL;
}

export function sharedMaxOutputTokens() {
  const value = Number(process.env.OLLAMA_MAX_OUTPUT_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1024;
}

export function sharedOllamaBaseUrl() {
  const raw = (process.env.OLLAMA_BASE_URL || "").trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

export async function sharedModelEnabled() {
  const setting = await AppSetting.findOne({ key: SHARED_SETTING_KEY }).lean();
  return setting ? setting.value !== false : true;
}

export async function setSharedModelEnabled(enabled) {
  await AppSetting.updateOne(
    { key: SHARED_SETTING_KEY },
    { $set: { value: Boolean(enabled) } },
    { upsert: true }
  );
  return Boolean(enabled);
}

export async function checkOllama() {
  const baseUrl = sharedOllamaBaseUrl();
  const model = sharedModelName();
  if (!baseUrl) return { status: "not_configured", model, available: false, installedModels: [] };

  let response;
  try {
    response = await fetch(`${baseUrl}/api/tags`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TAGS_TIMEOUT_MS)
    });
  } catch {
    return { status: "unreachable", model, available: false, installedModels: [] };
  }
  if (!response.ok) return { status: "unreachable", model, available: false, installedModels: [] };

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { status: "unreachable", model, available: false, installedModels: [] };
  }
  const installedModels = (Array.isArray(payload?.models) ? payload.models : [])
    .map(entry => (typeof entry?.name === "string" ? entry.name : typeof entry?.model === "string" ? entry.model : ""))
    .filter(Boolean)
    .slice(0, 200);
  const installed = installedModels.some(name => name === model || name === `${model}:latest` || name.startsWith(`${model}:`));
  return { status: installed ? "available" : "missing_model", model, available: installed, installedModels };
}

export async function sharedModelStatus() {
  const [enabled, check] = await Promise.all([sharedModelEnabled(), checkOllama()]);
  return {
    enabled,
    model: check.model,
    available: enabled && check.available,
    status: enabled ? check.status : "disabled"
  };
}

export function sharedProviderForChat() {
  const baseUrl = sharedOllamaBaseUrl();
  if (!baseUrl) return null;
  return {
    provider: SHARED_PROVIDER_LABEL,
    baseUrl: `${baseUrl}/v1`,
    apiKey: "ollama-shared",
    defaultModel: sharedModelName(),
    maxTokens: sharedMaxOutputTokens()
  };
}
