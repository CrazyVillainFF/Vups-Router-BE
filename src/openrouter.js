import { createHash } from "node:crypto";
import { normalizeCapabilities } from "./modelCapabilities.js";

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
export const OPENROUTER_CATALOG_TTL_DEFAULT = 300000;
export const OPENROUTER_CATALOG_STALE_DEFAULT = 86400000;

const MODELS_TIMEOUT_MS = 10000;
const MAX_MODEL_ID_LENGTH = 200;
let catalogCache = null;

export function resetOpenRouterCache() {
  catalogCache = null;
}

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

function configuredDefaultModel() {
  const model = (process.env.OPENROUTER_DEFAULT_MODEL || process.env.OPENROUTER_MODEL || "").trim();
  return model || null;
}

export function openRouterModel() {
  return configuredDefaultModel() || DEFAULT_OPENROUTER_MODEL;
}

export function openRouterFallbackModel() {
  return (process.env.OPENROUTER_FALLBACK_MODEL || "").trim() || null;
}

export function openRouterModels() {
  const configured = (process.env.OPENROUTER_MODELS || "")
    .split(",")
    .map(value => value.trim())
    .filter(value => value && value.length <= MAX_MODEL_ID_LENGTH && !/\s/.test(value));
  const list = configured.length > 0 ? configured : DEFAULT_OPENROUTER_MODELS;
  const ordered = [openRouterModel(), ...list].filter(Boolean);
  return [...new Set(ordered)];
}

function explicitModels() {
  const configured = (process.env.OPENROUTER_MODELS || "")
    .split(",")
    .map(value => value.trim())
    .filter(value => value && value.length <= MAX_MODEL_ID_LENGTH && !/\s/.test(value));
  if (configured.length === 0) return null;
  return [...new Set([openRouterModel(), ...configured])];
}

export function openRouterVisionModels() {
  return new Set(
    (process.env.OPENROUTER_VISION_MODELS || "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
  );
}

function modelSupportsImages(entry, id, overrides) {
  const modalities = entry?.architecture?.input_modalities;
  if (Array.isArray(modalities)) return modalities.includes("image");
  return overrides.has(id);
}

function modelCapabilities(entry, id, overrides) {
  const capabilities = normalizeCapabilities(entry);
  capabilities.vision = modelSupportsImages(entry, id, overrides);
  return capabilities;
}

function priceValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function openRouterModelIsFree(entry) {
  const prompt = priceValue(entry?.pricing?.prompt);
  const completion = priceValue(entry?.pricing?.completion);
  if (prompt !== 0 || completion !== 0) return false;
  const request = priceValue(entry?.pricing?.request);
  return request === null || request === 0;
}

function supportsTextOutput(entry) {
  const modalities = entry?.architecture?.output_modalities;
  if (Array.isArray(modalities)) return modalities.includes("text");
  const modality = String(entry?.architecture?.modality || "").toLowerCase();
  return /(^|->)text$/.test(modality);
}

export function openRouterModelIsChat(entry) {
  return typeof entry?.id === "string" && entry.id.length > 0 && supportsTextOutput(entry);
}

function providerName(id) {
  return id.includes("/") ? id.split("/")[0] : "openrouter";
}

function modelRow(entry, id, overrides) {
  const capabilities = modelCapabilities(entry, id, overrides);
  const free = openRouterModelIsFree(entry);
  const available = Boolean(entry) && free && openRouterModelIsChat(entry);
  return {
    id,
    name: typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : id,
    ownedBy: providerName(id),
    provider: providerName(id),
    available,
    free,
    ...(available ? {} : { reason: entry ? (free ? "not_chat" : "not_free") : "missing" }),
    vision: capabilities.vision,
    capabilities,
    contextLength: capabilities.contextLength,
    maxOutputTokens: capabilities.maxOutputTokens
  };
}

function unavailableRows(ids, overrides) {
  return ids.map(id => ({
    id,
    name: id,
    ownedBy: providerName(id),
    provider: providerName(id),
    available: false,
    free: null,
    vision: overrides.has(id),
    capabilities: modelCapabilities(undefined, id, overrides),
    contextLength: null,
    maxOutputTokens: null
  }));
}

function cacheKey(baseUrl, key) {
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `${baseUrl}|${digest}`;
}

function catalogTtlMs() {
  const value = Number(process.env.OPENROUTER_CATALOG_TTL_MS);
  return Number.isFinite(value) && value >= 0 ? value : OPENROUTER_CATALOG_TTL_DEFAULT;
}

function catalogStaleMs() {
  const value = Number(process.env.OPENROUTER_CATALOG_STALE_MS);
  return Number.isFinite(value) && value > 0 ? value : OPENROUTER_CATALOG_STALE_DEFAULT;
}

function catalogFailure(code, status = null) {
  const error = new Error("OpenRouter catalog request failed.");
  error.code = code;
  error.status = status;
  return error;
}

async function fetchCatalog(baseUrl, key) {
  let response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
    });
  } catch {
    throw catalogFailure("unreachable");
  }
  if (response.status === 401 || response.status === 403) throw catalogFailure("unauthorized", response.status);
  if (response.status === 429) throw catalogFailure("rate_limited", response.status);
  if (!response.ok) throw catalogFailure("unreachable", response.status);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw catalogFailure("invalid_response");
  }
  if (!Array.isArray(payload?.data)) throw catalogFailure("invalid_response");
  return payload.data.filter(entry => typeof entry?.id === "string" && entry.id.length > 0);
}

async function getCatalog(baseUrl, key, forceRefresh = false) {
  const keyId = cacheKey(baseUrl, key);
  const now = Date.now();
  if (!forceRefresh && catalogCache?.key === keyId && now - catalogCache.at <= catalogTtlMs()) {
    return { entries: catalogCache.entries, stale: false };
  }

  try {
    const entries = await fetchCatalog(baseUrl, key);
    catalogCache = { key: keyId, at: now, entries };
    return { entries, stale: false };
  } catch (error) {
    const canUseStale =
      error.code !== "unauthorized" &&
      catalogCache?.key === keyId &&
      now - catalogCache.at <= catalogStaleMs();
    if (canUseStale) return { entries: catalogCache.entries, stale: true };
    throw error;
  }
}

export function openRouterMaxOutputTokens() {
  const value = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(value) || value <= 0) return OPENROUTER_MAX_OUTPUT_TOKENS_DEFAULT;
  return Math.min(Math.floor(value), OPENROUTER_MAX_OUTPUT_TOKENS_LIMIT);
}

export async function checkOpenRouter({ forceRefresh = false } = {}) {
  const overrides = openRouterVisionModels();
  const configuredDefault = configuredDefaultModel();
  const configuredFallback = openRouterFallbackModel();
  const requestedDefault = openRouterModel();
  const allowlist = explicitModels();
  const fallbackIds = allowlist || DEFAULT_OPENROUTER_MODELS;
  const key = openRouterApiKey();
  const baseUrl = openRouterBaseUrl();

  if (!key || !baseUrl) {
    return {
      status: "not_configured",
      model: requestedDefault,
      fallbackModel: configuredFallback,
      available: false,
      models: unavailableRows(fallbackIds, overrides)
    };
  }

  let catalog;
  try {
    catalog = await getCatalog(baseUrl, key, forceRefresh);
  } catch (error) {
    const status = ["unauthorized", "rate_limited", "invalid_response"].includes(error.code)
      ? error.code
      : "unreachable";
    return {
      status,
      model: requestedDefault,
      fallbackModel: configuredFallback,
      available: false,
      models: unavailableRows(fallbackIds, overrides)
    };
  }

  const byId = new Map(catalog.entries.map(entry => [entry.id, entry]));
  const checked = allowlist
    ? allowlist.map(id => modelRow(byId.get(id), id, overrides))
    : catalog.entries
        .filter(entry => openRouterModelIsFree(entry) && openRouterModelIsChat(entry))
        .map(entry => modelRow(entry, entry.id, overrides))
        .sort((a, b) => a.id.localeCompare(b.id));

  const ready = checked.filter(model => model.available);
  if (ready.length === 0) {
    return {
      status: byId.size === 0 ? "empty" : "missing_model",
      model: requestedDefault,
      fallbackModel: configuredFallback,
      available: false,
      models: checked,
      catalogStale: catalog.stale
    };
  }

  const defaultReady = ready.some(model => model.id === requestedDefault);
  const model = defaultReady ? requestedDefault : ready[0].id;
  const fallbackReady = configuredFallback && configuredFallback !== model
    ? ready.find(candidate => candidate.id === configuredFallback)
    : null;
  const fallbackModel = fallbackReady?.id || ready.find(candidate => candidate.id !== model)?.id || null;
  const orderedModels = [
    ...checked.filter(candidate => candidate.id === model),
    ...checked.filter(candidate => candidate.id !== model)
  ];

  return {
    status: "available",
    model,
    fallbackModel,
    available: true,
    freeOnly: !allowlist,
    defaultUnavailable: Boolean(configuredDefault && !defaultReady),
    catalogStale: catalog.stale,
    models: orderedModels
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
