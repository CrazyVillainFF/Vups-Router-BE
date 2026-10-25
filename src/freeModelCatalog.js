import ProviderConfig from "./providerConfig.js";
import { decryptSecret, maskApiKey } from "./encryption.js";
import { ProviderError, listProviderModels } from "./providerClient.js";
import { SHARED_OWNER_LABEL, sharedModelStatus } from "./sharedModel.js";

const CATALOG_TTL_DEFAULT = 300000;
const CATALOG_STALE_DEFAULT = 86400000;
const DISCOVERY_TIMEOUT_MS = 12000;
const MAX_FREE_MODELS_PER_CONFIG = 500;
const MAX_CONCURRENT_DISCOVERIES = 4;

let catalogCache = new Map();

export function resetFreeModelCatalogCache() {
  catalogCache = new Map();
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function catalogTtlMs() {
  return positiveNumber(process.env.FREE_CATALOG_TTL_MS, CATALOG_TTL_DEFAULT);
}

function catalogStaleMs() {
  return positiveNumber(process.env.FREE_CATALOG_STALE_MS, CATALOG_STALE_DEFAULT);
}

function configSignature(configs) {
  return configs
    .map(config => [
      config.configId,
      config.providerId,
      config.baseUrl,
      config.providerType,
      config.updatedAt ? new Date(config.updatedAt).getTime() : 0
    ].join(":"))
    .sort()
    .join("|");
}

function safeProviderError(error) {
  if (error instanceof ProviderError) {
    return { code: error.code || "provider_error", message: error.message };
  }
  return { code: "provider_error", message: "The provider's model catalogue could not be read." };
}

function sharedRows(shared) {
  if (!shared?.enabled || !shared.available || !Array.isArray(shared.models)) return [];
  const providerName = shared.provider === "openrouter" ? "OpenRouter" : shared.provider === "ollama" ? "Ollama" : SHARED_OWNER_LABEL;
  return shared.models
    .filter(model => model && model.available !== false && (model.free === true || (shared.provider === "ollama" && model.free !== false)))
    .filter(model => typeof model.id === "string" && model.id.trim())
    .map(model => ({
      id: model.id.trim(),
      name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id.trim(),
      ownedBy: providerName,
      provider: providerName,
      providerId: shared.provider || "shared",
      configId: "",
      shared: true,
      free: true,
      verifiedFree: true,
      freeSource: "shared_catalog",
      vision: model.vision === true ? true : model.vision === false ? false : null,
      capabilities: model.capabilities && typeof model.capabilities === "object" ? model.capabilities : null,
      contextLength: model.contextLength ?? model.capabilities?.contextLength ?? null,
      maxOutputTokens: model.maxOutputTokens ?? model.capabilities?.maxOutputTokens ?? null
    }));
}

function personalRows(config, models, apiKeyMasked = "") {
  return models
    .filter(model => model && model.free === true && model.restrictedProvider !== true)
    .filter(model => typeof model.id === "string" && model.id.trim())
    .slice(0, MAX_FREE_MODELS_PER_CONFIG)
    .map(model => ({
      id: model.id.trim(),
      name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : model.id.trim(),
      ownedBy: config.provider,
      provider: config.provider,
      providerId: config.providerId,
      configId: config.configId,
      apiKeyMasked,
      shared: false,
      free: true,
      verifiedFree: true,
      freeSource: "provider_pricing",
      vision: model.vision === true ? true : model.vision === false ? false : null,
      capabilities: model.capabilities && typeof model.capabilities === "object" ? model.capabilities : null,
      contextLength: model.contextLength ?? model.capabilities?.contextLength ?? null,
      maxOutputTokens: model.maxOutputTokens ?? model.capabilities?.maxOutputTokens ?? null
    }));
}

async function discoverPersonal(config) {
  let apiKey;
  try {
    apiKey = decryptSecret(config.encryptedApiKey);
  } catch {
    throw new ProviderError(
      "The stored API key could not be decrypted. Re-enter and save your key in Settings.",
      null,
      "key_decryption_failed"
    );
  }
  const models = await listProviderModels(
    { baseUrl: config.baseUrl, apiKey, providerType: config.providerType },
    AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
  );
  const rows = personalRows(config, models, maskApiKey(apiKey));
  const verifiedIds = [...new Set(rows.map(row => row.id))].sort();
  try {
    const changed = JSON.stringify(verifiedIds) !== JSON.stringify([...(config.freeModels || [])].sort());
    if (changed || !config.freeModelsAt) {
      await ProviderConfig.updateOne(
        { _id: config._id },
        { $set: { freeModels: verifiedIds, freeModelsAt: new Date() } },
        { timestamps: false }
      );
    }
  } catch {
    throw new ProviderError(
      "Free models were found, but the verified list could not be saved for routing. Refresh the free catalogue and try again.",
      null,
      "free_catalog_persist_failed"
    );
  }
  return rows;
}

async function discoverConfigs(configs) {
  const rows = [];
  const providers = [];
  const errors = [];
  for (let index = 0; index < configs.length; index += MAX_CONCURRENT_DISCOVERIES) {
    const batch = configs.slice(index, index + MAX_CONCURRENT_DISCOVERIES);
    const settled = await Promise.allSettled(batch.map(config => discoverPersonal(config)));
    settled.forEach((result, batchIndex) => {
      const config = batch[batchIndex];
      const provider = {
        id: config.configId,
        providerId: config.providerId,
        name: config.provider,
        shared: false,
        status: "available",
        modelCount: 0
      };
      if (result.status === "fulfilled") {
        rows.push(...result.value);
        provider.modelCount = result.value.length;
        if (result.value.length === 0) provider.status = "no_free_models";
      } else {
        const error = safeProviderError(result.reason);
        provider.status = "error";
        provider.error = error;
        errors.push({ configId: config.configId, provider: config.provider, ...error });
      }
      providers.push(provider);
    });
  }
  return { rows, providers, errors };
}

function dedupeRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.shared ? "shared" : `personal:${row.configId}`}:${row.id}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

function buildResult({ rows, providers, errors, shared, cached, stale, updatedAt }) {
  const models = dedupeRows(rows);
  return {
    models,
    providers,
    errors,
    counts: {
      models: models.length,
      sharedModels: models.filter(row => row.shared).length,
      personalModels: models.filter(row => !row.shared).length,
      providers: providers.length
    },
    shared: shared
      ? {
          provider: shared.provider,
          status: shared.enabled ? shared.status : "disabled",
          enabled: shared.enabled !== false,
          available: shared.available === true,
          catalogStale: shared.catalogStale === true
        }
      : null,
    cached,
    stale,
    partial: errors.length > 0,
    updatedAt
  };
}

function staleCopy(entry, errors) {
  return buildResult({
    rows: entry.data.models,
    providers: entry.data.providers,
    errors,
    shared: null,
    cached: false,
    stale: true,
    updatedAt: entry.data.updatedAt
  });
}

export async function freeModelCatalogForUser(userId, { forceRefresh = false } = {}) {
  const configs = (await ProviderConfig.find({ userId })
    .sort({ active: -1, updatedAt: -1 })
    .select("+encryptedApiKey")).filter(config => config.enabled !== false);
  const signature = configSignature(configs);
  const now = Date.now();
  const previous = catalogCache.get(String(userId));
  if (!forceRefresh && previous?.signature === signature && now - previous.at <= catalogTtlMs()) {
    return { ...previous.data, cached: true, stale: false };
  }

  let shared = null;
  let sharedFailure = null;
  try {
    shared = await sharedModelStatus();
  } catch {
    sharedFailure = {
      code: "shared_unavailable",
      message: "The shared free-model catalogue is temporarily unavailable."
    };
  }

  const sharedCatalogRows = sharedRows(shared);
  const discovered = await discoverConfigs(configs);
  const sharedProvider = shared
    ? {
        id: shared.provider || "shared",
        providerId: shared.provider || "shared",
        name: shared.provider === "openrouter" ? "OpenRouter" : shared.provider === "ollama" ? "Ollama" : SHARED_OWNER_LABEL,
        shared: true,
        status: shared.enabled === false ? "disabled" : shared.available ? "available" : "unavailable",
        modelCount: sharedCatalogRows.length,
        ...(shared.enabled !== false && !shared.available ? { error: { code: shared.status || "unavailable", message: "The shared free-model catalogue is not available right now." } } : {})
      }
    : sharedFailure
      ? {
          id: "shared",
          providerId: "shared",
          name: "Shared free models",
          shared: true,
          status: "error",
          modelCount: 0,
          error: sharedFailure
        }
      : null;

  const providers = [
    ...(sharedProvider ? [sharedProvider] : []),
    ...discovered.providers
  ];
  const errors = [
    ...discovered.errors,
    ...(sharedFailure ? [{ provider: "Shared free models", ...sharedFailure }] : [])
  ];
  const rows = [...sharedCatalogRows, ...discovered.rows];

  if (rows.length === 0 && previous && now - previous.at <= catalogStaleMs()) {
    catalogCache.set(String(userId), previous);
    return staleCopy(previous, errors);
  }

  const data = buildResult({
    rows,
    providers,
    errors,
    shared,
    cached: false,
    stale: false,
    updatedAt: new Date().toISOString()
  });
  catalogCache.set(String(userId), { signature, at: now, data });
  return data;
}
