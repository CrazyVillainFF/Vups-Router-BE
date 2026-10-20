import { ProviderError } from "./providerClient.js";

export const OMNIROUTE_PROVIDER_LABEL = "OmniRoute";
export const OMNIROUTE_OWNER_LABEL = "OmniRoute gateway";
export const DEFAULT_OMNIROUTE_BASE_URL = "http://localhost:20128";
export const OMNIROUTE_MAX_MODELS = 500;

const MODELS_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 30000;
const PATH_SUFFIX = /\/(v\d+|chat\/completions|responses|messages|completions|models|embeddings)$/i;

let cache = null;

export function resetOmniRouteCache() {
  cache = null;
}

export function normalizeOmniRouteBaseUrl(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderError("OMNIROUTE_BASE_URL is required.", 400, "invalid_base_url");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new ProviderError("OMNIROUTE_BASE_URL must be a valid URL such as http://localhost:20128.", 400, "invalid_base_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderError("OMNIROUTE_BASE_URL must start with http:// or https://.", 400, "invalid_base_url");
  }
  if (parsed.username || parsed.password) {
    throw new ProviderError("OMNIROUTE_BASE_URL must not contain embedded credentials.", 400, "invalid_base_url");
  }
  if (parsed.search || parsed.hash) {
    throw new ProviderError("OMNIROUTE_BASE_URL must not include a query string or fragment.", 400, "invalid_base_url");
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  while (PATH_SUFFIX.test(path)) {
    const next = path.replace(PATH_SUFFIX, "");
    if (next === path) break;
    path = next;
  }
  return parsed.origin + path;
}

export function omnirouteApiKey() {
  const key = (process.env.OMNIROUTE_API_KEY || "").trim();
  return key || null;
}

export function omnirouteBaseUrl() {
  const raw = (process.env.OMNIROUTE_BASE_URL || "").trim();
  if (!raw) return null;
  try {
    return normalizeOmniRouteBaseUrl(raw);
  } catch {
    return null;
  }
}

export function omnirouteConfiguration() {
  const apiKey = omnirouteApiKey();
  const rawBaseUrl = (process.env.OMNIROUTE_BASE_URL || "").trim();
  const configured = Boolean(apiKey && rawBaseUrl);
  const flag = (process.env.OMNIROUTE_ENABLED || "").trim().toLowerCase();
  const disabled = flag.length > 0 && !["true", "1", "yes", "on"].includes(flag);
  const enabled = flag.length > 0 ? !disabled : configured;

  if (!enabled) {
    return { enabled: false, configured, status: "disabled", baseUrl: null, apiKey: null };
  }
  if (!configured) {
    return { enabled: true, configured: false, status: "not_configured", baseUrl: null, apiKey: null };
  }
  try {
    return { enabled: true, configured: true, status: "ready", baseUrl: normalizeOmniRouteBaseUrl(rawBaseUrl), apiKey };
  } catch {
    return { enabled: true, configured: true, status: "invalid_config", baseUrl: null, apiKey: null };
  }
}

export function omnirouteConfigured() {
  return omnirouteConfiguration().status === "ready";
}

export function omnirouteEndpoint(pathname = "") {
  const baseUrl = omnirouteBaseUrl();
  if (!baseUrl) return null;
  const path = typeof pathname === "string" && pathname.startsWith("/") ? pathname : `/${String(pathname || "")}`;
  return `${baseUrl}/v1${path}`;
}

export function normalizeOmniRouteModels(entries) {
  const models = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : typeof entry?.name === "string" ? entry.name.trim() : "";
    if (!id || id.length > 200 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 200) : id;
    const modalities = entry?.architecture?.input_modalities;
    const vision = Array.isArray(modalities) ? modalities.includes("image") : null;
    models.push({ id, name, vision });
    if (models.length >= OMNIROUTE_MAX_MODELS) break;
  }
  return models;
}

function statusResult(status, { enabled = true, configured = true, models = [] } = {}) {
  return {
    enabled,
    configured,
    provider: "omniroute",
    status,
    available: status === "available",
    models
  };
}

async function fetchOmniRouteModels({ baseUrl, apiKey }, { timeoutMs, signal } = {}) {
  const url = `${baseUrl}/v1/models`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: signal ?? AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs >= 100 ? timeoutMs : MODELS_TIMEOUT_MS)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    return statusResult(timedOut ? "timeout" : "unreachable");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return statusResult("unauthorized");
    if (response.status === 404) return statusResult("not_found");
    if (response.status === 429) return statusResult("rate_limited");
    return statusResult("unavailable");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return statusResult("invalid_response");
  }
  const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const models = normalizeOmniRouteModels(entries);
  if (models.length === 0) return statusResult("empty", { models: [] });
  return statusResult("available", { models });
}

export async function checkOmniRoute({ force = false, timeoutMs, signal } = {}) {
  const now = Date.now();
  if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const configuration = omnirouteConfiguration();
  let result;
  if (configuration.status !== "ready") {
    result = statusResult(configuration.status, {
      enabled: configuration.enabled,
      configured: configuration.configured
    });
  } else {
    try {
      result = await fetchOmniRouteModels(configuration, { timeoutMs, signal });
    } catch {
      result = statusResult("unavailable");
    }
  }
  cache = { at: now, value: result };
  return result;
}

export function publicOmniRouteStatus(status) {
  const value = status ?? { enabled: false, configured: false, status: "disabled", available: false, models: [] };
  return {
    provider: OMNIROUTE_PROVIDER_LABEL,
    enabled: value.enabled !== false,
    configured: value.configured === true,
    available: value.available === true,
    status: value.status,
    modelCount: Array.isArray(value.models) ? value.models.length : 0
  };
}

export function omnirouteModelRows(status) {
  if (!status?.available) return [];
  return status.models.map(model => ({
    id: model.id,
    name: model.name,
    ownedBy: OMNIROUTE_OWNER_LABEL,
    provider: OMNIROUTE_PROVIDER_LABEL,
    source: "omniroute",
    gateway: true,
    shared: false,
    saved: false,
    vision: model.vision === true ? true : null
  }));
}

export function omnirouteProviderForChat() {
  const configuration = omnirouteConfiguration();
  if (configuration.status !== "ready") return null;
  return {
    provider: OMNIROUTE_PROVIDER_LABEL,
    baseUrl: `${configuration.baseUrl}/v1`,
    apiKey: configuration.apiKey,
    defaultModel: "",
    maxTokens: undefined
  };
}

export function omnirouteStatusError(status) {
  switch (status?.status) {
    case "disabled":
      return new ProviderError(
        "OmniRoute has been disabled on this server. Pick another model or ask the administrator to enable it.",
        503,
        "omniroute_disabled"
      );
    case "not_configured":
      return new ProviderError(
        "OmniRoute is not configured on this server. Ask the administrator to set OMNIROUTE_BASE_URL and OMNIROUTE_API_KEY.",
        503,
        "omniroute_not_configured"
      );
    case "invalid_config":
      return new ProviderError(
        "The OmniRoute configuration on this server is invalid. Ask the administrator to check OMNIROUTE_BASE_URL.",
        503,
        "omniroute_invalid_config"
      );
    case "unauthorized":
      return new ProviderError(
        "OmniRoute rejected the API key configured on this server. Ask the administrator to verify OMNIROUTE_API_KEY.",
        503,
        "omniroute_auth_failed"
      );
    case "rate_limited":
      return new ProviderError("OmniRoute is rate-limiting this server right now. Try again shortly.", 429, "omniroute_rate_limited");
    case "timeout":
      return new ProviderError("Timed out while contacting OmniRoute. Try again shortly.", 504, "omniroute_timeout");
    case "not_found":
      return new ProviderError("OmniRoute's model endpoint was not found. Ask the administrator to check OMNIROUTE_BASE_URL.", 503, "omniroute_unavailable");
    case "empty":
      return new ProviderError(
        "OmniRoute reports no available models. Configure providers inside OmniRoute or pick another model.",
        503,
        "omniroute_no_models"
      );
    default:
      return new ProviderError(
        "OmniRoute is unreachable right now. Try again shortly or pick another model.",
        503,
        "omniroute_unreachable"
      );
  }
}

export async function resolveOmniRouteChat(requestedModel = "") {
  const status = await checkOmniRoute();
  if (!status.available) throw omnirouteStatusError(status);
  const provider = omnirouteProviderForChat();
  if (!provider) throw omnirouteStatusError(status);

  const ids = status.models.map(model => model.id);
  const requested = typeof requestedModel === "string" ? requestedModel.trim() : "";
  let model = requested;
  if (model) {
    if (model.length > 200 || !ids.includes(model)) {
      const alternatives = ids.slice(0, 10).join(", ");
      throw new ProviderError(
        `"${model.slice(0, 80)}" is not an available OmniRoute model. Choose one of: ${alternatives}.`,
        400,
        "invalid_model"
      );
    }
  } else {
    model = ids[0];
  }
  return {
    gateway: true,
    provider: provider.provider,
    providerType: provider.providerType || "openai_compatible",
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    defaultModel: model,
    maxTokens: provider.maxTokens,
    visionModelIds: status.models.filter(entry => entry.vision === true).map(entry => entry.id)
  };
}
