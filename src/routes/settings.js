import { Router } from "express";
import connectToDatabase from "../db.js";
import ProviderConfig, { ensureProviderIndexes, newConfigId, providerIdFromName } from "../providerConfig.js";
import { decryptSecret, encryptSecret, maskApiKey } from "../encryption.js";
import {
  ProviderError,
  assertAllowedProviderUrl,
  listProviderModels,
  normalizeBaseUrl,
  normalizeProviderType,
  testProviderConnection,
  testProviderModel,
  validateProviderFields
} from "../providerClient.js";
import { requireAuth, settingsRateLimiter } from "../middleware.js";
import { SHARED_OWNER_LABEL, sharedModelStatus } from "../sharedModel.js";
import { checkOmniRoute, omnirouteModelRows, publicOmniRouteStatus } from "../omniroute.js";

const router = Router();

router.use(requireAuth);
router.use(settingsRateLimiter);

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;
const CONFIG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

function publicConfig(config) {
  if (!config) {
    return {
      configured: false,
      configId: "",
      providerId: "",
      provider: "",
      providerType: "openai_compatible",
      baseUrl: "",
      model: "",
      models: [],
      defaultModel: "",
      enabled: true,
      active: false,
      hasApiKey: false,
      apiKeyMasked: "",
      lastTest: null
    };
  }
  return {
    configured: true,
    configId: config.configId || config.providerId || providerIdFromName(config.provider),
    providerId: config.providerId || providerIdFromName(config.provider),
    provider: config.provider,
    providerType: config.providerType || "openai_compatible",
    baseUrl: config.baseUrl,
    model: config.model || "",
    models: Array.isArray(config.models) ? config.models : [],
    defaultModel: config.defaultModel || config.model || "",
    enabled: config.enabled !== false,
    active: Boolean(config.active),
    hasApiKey: Boolean(config.encryptedApiKey),
    apiKeyMasked: config.encryptedApiKey ? safeMask(config.encryptedApiKey) : "",
    updatedAt: config.updatedAt,
    lastTest: config.lastTestAt
      ? {
          status: config.lastTestStatus,
          code: config.lastTestCode,
          message: config.lastTestMessage,
          at: config.lastTestAt
        }
      : null
  };
}

function safeMask(encryptedApiKey) {
  try {
    return maskApiKey(decryptSecret(encryptedApiKey));
  } catch {
    return "";
  }
}

function testStatusFor(error) {
  if (error.code === "invalid_api_key") return "invalid_key";
  if (error.code === "insufficient_credits") return "insufficient_balance";
  if (error.code === "model_unavailable") return "model_unavailable";
  if (error.code === "timeout") return "timeout";
  if (error.code === "network_error" || error.code === "dns_error" || error.code === "connection_refused") return "unreachable";
  if (error.code === "local_endpoint" || error.code === "private_endpoint") return "unreachable";
  return "failed";
}

async function recordTestResult(userId, config, status, code, message) {
  if (!config?._id) return;
  try {
    await ProviderConfig.updateOne(
      { userId, _id: config._id },
      {
        $set: {
          lastTestStatus: status,
          lastTestCode: code || "",
          lastTestMessage: String(message || "").slice(0, 400),
          lastTestAt: new Date()
        }
      }
    );
  } catch {
    // Recording the test outcome is best-effort and must never fail the response.
  }
}

async function loadActiveConfig(userId) {
  const active = await ProviderConfig.findOne({ userId, active: true }).select("+encryptedApiKey");
  if (active) return active;
  return ProviderConfig.findOne({ userId }).sort({ updatedAt: -1 }).select("+encryptedApiKey");
}

// Backward-compatible migration: configurations saved before multi-provider
// support have no providerId; configurations saved before multi-config support
// have no configId. Derive stable values once and persist them without touching
// any other field. Existing providerId values are already unique per user, so
// they are reused as the initial configId.
async function ensureProviderIds(userId) {
  const configs = await ProviderConfig.find({ userId }).select("+encryptedApiKey");
  const taken = new Set(configs.map(config => config.providerId).filter(Boolean));
  for (const config of configs) {
    if (!config.providerId) {
      let candidate = providerIdFromName(config.provider);
      let suffix = 2;
      while (taken.has(candidate)) {
        candidate = `${providerIdFromName(config.provider)}-${suffix}`;
        suffix += 1;
      }
      taken.add(candidate);
      await ProviderConfig.updateOne({ _id: config._id }, { $set: { providerId: candidate } });
      config.providerId = candidate;
    }
    if (!config.configId) {
      await ProviderConfig.updateOne({ _id: config._id }, { $set: { configId: config.providerId } });
      config.configId = config.providerId;
    }
  }
  // Legacy rows are migrated first so the unique configId index can be built
  // without tripping over several documents that all miss the field.
  await ensureProviderIndexes();
  return configs;
}

function providerErrorResponse(res, error) {
  if (error instanceof ProviderError) {
    return res.status(400).json({ message: error.message, code: error.code });
  }
  return null;
}

async function activateProvider(userId, configId) {
  // Only the previously active configuration is touched; every other
  // configuration (keys, URLs, models, defaults, timestamps) stays untouched.
  await ProviderConfig.updateMany({ userId, configId: { $ne: configId }, active: true }, { $set: { active: false } });
  return ProviderConfig.findOneAndUpdate(
    { userId, configId },
    { $set: { active: true } },
    { returnDocument: "after" }
  );
}

function sanitizeProviderId(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return PROVIDER_ID_PATTERN.test(candidate) ? candidate : "";
}

function buildProviderUpdate(input, existing) {
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const validationError = validateProviderFields(
    { provider: input.provider, baseUrl: input.baseUrl, apiKey, model: input.model ?? "" },
    { requireKey: !existing?.encryptedApiKey || apiKey.length > 0 }
  );
  if (validationError) return { error: validationError };

  const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
  assertAllowedProviderUrl(normalizedBaseUrl);

  const providerType = normalizeProviderType(input.providerType || existing?.providerType || "openai_compatible");
  const update = {
    providerId: sanitizeProviderId(input.providerId) || providerIdFromName(input.provider),
    provider: input.provider.trim(),
    providerType,
    baseUrl: normalizedBaseUrl,
    model: typeof input.model === "string" ? input.model.trim() : existing?.model || ""
  };
  if (apiKey.length > 0) update.encryptedApiKey = encryptSecret(apiKey);
  return { update };
}

// A row identity can arrive as the stable configId or, for older clients, as
// the providerId slug. configId wins; providerId resolves to the active or
// newest configuration using that slug.
async function resolveStoredConfig(userId, identifier) {
  const value = String(identifier || "").trim();
  if (!value) return null;
  const byConfigId = await ProviderConfig.findOne({ userId, configId: value }).select("+encryptedApiKey");
  if (byConfigId) return byConfigId;
  return ProviderConfig.findOne({ userId, providerId: value })
    .sort({ active: -1, updatedAt: -1 })
    .select("+encryptedApiKey");
}

function decryptedMask(config) {
  return config?.encryptedApiKey ? safeMask(config.encryptedApiKey) : "";
}

function modelIdsFor(config) {
  const saved = Array.isArray(config.models) ? config.models.filter(Boolean) : [];
  if (saved.length > 0) return saved;
  const single = config.defaultModel || config.model;
  return single ? [single] : [];
}

function savedModelRows(config) {
  const apiKeyMasked = decryptedMask(config);
  return modelIdsFor(config).map(id => ({
    id,
    name: id,
    ownedBy: config.provider,
    provider: config.provider,
    providerId: config.providerId,
    configId: config.configId,
    apiKeyMasked,
    shared: false,
    saved: true,
    vision: null
  }));
}

async function storedApiKey(config) {
  try {
    return decryptSecret(config.encryptedApiKey);
  } catch {
    return null;
  }
}

// ─── Multi-configuration management ─────────────────────────────────────────

router.get("/providers", async (req, res, next) => {
  try {
    await connectToDatabase();
    const configs = await ensureProviderIds(req.userId);
    let activeConfigId = configs.find(config => config.active)?.configId || "";
    if (!activeConfigId && configs.length > 0) {
      const newest = configs.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
      await activateProvider(req.userId, newest.configId);
      activeConfigId = newest.configId;
      const marked = configs.find(config => config.configId === newest.configId);
      if (marked) marked.active = true;
    }
    const providers = configs
      .slice()
      .sort((a, b) => Number(b.active) - Number(a.active) || new Date(b.updatedAt) - new Date(a.updatedAt))
      .map(publicConfig);
    return res.json({ providers, activeProviderId: activeConfigId, activeConfigId });
  } catch (error) {
    return next(error);
  }
});

// Explicit create: always appends a NEW configuration (even for a provider the
// user has already configured) with a server-generated stable configId.
router.post("/providers", async (req, res, next) => {
  try {
    const input = req.body || {};
    await connectToDatabase();
    await ensureProviderIds(req.userId);
    const built = buildProviderUpdate(input, null);
    if (built.error) return res.status(400).json({ message: built.error });
    const configId = newConfigId();
    const created = await ProviderConfig.create({
      userId: req.userId,
      configId,
      ...built.update,
      active: false,
      enabled: true,
      models: [],
      defaultModel: ""
    });
    await activateProvider(req.userId, configId);
    const saved = await ProviderConfig.findOne({ _id: created._id }).select("+encryptedApiKey");
    return res.status(201).json({ message: `${saved.provider} saved.`, config: publicConfig(saved) });
  } catch (error) {
    return providerErrorResponse(res, error) ?? next(error);
  }
});

// Upsert by stable configId (or legacy providerId alias). Editing an existing
// configuration never touches any other configuration; creating through PUT
// keeps backward compatibility with the previous API shape.
router.put("/providers/:identifier", async (req, res, next) => {
  try {
    const identifier = String(req.params.identifier || "").trim().toLowerCase();
    if (!CONFIG_ID_PATTERN.test(identifier)) {
      return res.status(400).json({ message: "The configuration id must be a lowercase slug." });
    }
    const input = req.body || {};
    await connectToDatabase();
    await ensureProviderIds(req.userId);
    const existing = await resolveStoredConfig(req.userId, identifier);
    const built = buildProviderUpdate(input, existing);
    if (built.error) return res.status(400).json({ message: built.error });

    let config;
    if (existing) {
      config = await ProviderConfig.findOneAndUpdate(
        { _id: existing._id },
        { $set: built.update },
        { returnDocument: "after" }
      ).select("+encryptedApiKey");
    } else {
      config = await ProviderConfig.create({
        userId: req.userId,
        configId: identifier,
        ...built.update,
        active: false,
        enabled: true,
        models: [],
        defaultModel: ""
      });
    }

    // A brand-new configuration becomes the selected one; editing an existing
    // configuration never steals the active selection.
    if (!existing) {
      await activateProvider(req.userId, config.configId);
      config = await ProviderConfig.findOne({ _id: config._id }).select("+encryptedApiKey");
    }
    return res.json({ message: `${config.provider} saved.`, config: publicConfig(config) });
  } catch (error) {
    return providerErrorResponse(res, error) ?? next(error);
  }
});

router.post("/providers/:identifier/activate", async (req, res, next) => {
  try {
    const identifier = String(req.params.identifier || "").trim().toLowerCase();
    await connectToDatabase();
    const stored = await resolveStoredConfig(req.userId, identifier);
    if (!stored) return res.status(404).json({ message: "That configuration is not saved." });
    await activateProvider(req.userId, stored.configId);
    return res.json({ message: `${stored.provider} is now the selected configuration.`, configId: stored.configId });
  } catch (error) {
    return next(error);
  }
});

router.delete("/providers/:identifier", async (req, res, next) => {
  try {
    const identifier = String(req.params.identifier || "").trim().toLowerCase();
    await connectToDatabase();
    const stored = await resolveStoredConfig(req.userId, identifier);
    if (!stored) return res.status(404).json({ message: "That configuration is not saved." });
    const deleted = await ProviderConfig.findOneAndDelete({ _id: stored._id });
    if (deleted.active) {
      const fallback = await ProviderConfig.findOne({ userId: req.userId }).sort({ updatedAt: -1 });
      if (fallback) await activateProvider(req.userId, fallback.configId);
    }
    return res.json({ message: `${deleted.provider} was removed.` });
  } catch (error) {
    return next(error);
  }
});

router.post("/providers/:identifier/test", async (req, res, next) => {
  try {
    const identifier = String(req.params.identifier || "").trim().toLowerCase();
    const input = req.body || {};
    await connectToDatabase();
    const stored = await resolveStoredConfig(req.userId, identifier);
    if (!stored) return res.status(404).json({ message: "That configuration is not saved." });
    const baseUrl = (input.baseUrl || stored.baseUrl || "").trim();
    const providerType = normalizeProviderType(input.providerType || stored.providerType);
    let apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey && stored.encryptedApiKey) {
      try {
        apiKey = decryptSecret(stored.encryptedApiKey);
      } catch {
        return res.status(500).json({ message: "The stored API key could not be decrypted. Re-enter and save your key." });
      }
    }
    if (!baseUrl) return res.status(400).json({ message: "Enter an API base URL first." });
    if (!apiKey) return res.status(400).json({ message: "Enter an API key first." });

    let normalizedBaseUrl;
    try {
      normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      assertAllowedProviderUrl(normalizedBaseUrl);
    } catch (error) {
      if (error instanceof ProviderError) {
        await recordTestResult(req.userId, stored, testStatusFor(error), error.code, error.message);
      }
      return providerErrorResponse(res, error);
    }

    try {
      const result = await testProviderConnection({ baseUrl: normalizedBaseUrl, apiKey, providerType });
      const parts = [result.listingSupported ? "Connection succeeded." : "Endpoint reached."];
      if (result.availableModels.length > 0) {
        parts.push(`${result.availableModels.length} models available.`);
        if (stored.models.length === 0) {
          // First successful discovery: persist the list so it survives later
          // outages. Never erases a list that already exists.
          await ProviderConfig.updateOne(
            { userId: req.userId, _id: stored._id, models: { $size: 0 } },
            { $set: { models: result.availableModels.map(entry => entry.id).slice(0, 500) } }
          );
        }
      } else if (result.warning) {
        parts.push(result.warning);
      }
      const message = parts.join(" ");
      await recordTestResult(req.userId, stored, result.listingSupported ? "connected" : "reachable", "", message);
      return res.json({
        ok: true,
        message,
        availableModels: result.availableModels,
        modelChecked: false,
        listingSupported: result.listingSupported,
        warning: result.warning
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        await recordTestResult(req.userId, stored, testStatusFor(error), error.code, error.message);
        return res.status(400).json({ ok: false, message: error.message, code: error.code });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.post("/providers/:identifier/test-model", async (req, res, next) => {
  try {
    const identifier = String(req.params.identifier || "").trim().toLowerCase();
    const input = req.body || {};
    await connectToDatabase();
    const stored = await resolveStoredConfig(req.userId, identifier);
    if (!stored) return res.status(404).json({ message: "That configuration is not saved." });
    const baseUrl = (input.baseUrl || stored.baseUrl || "").trim();
    const model = String(input.model ?? stored.defaultModel ?? stored.model ?? "").trim();
    const providerType = normalizeProviderType(input.providerType || stored.providerType);
    let apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey && stored.encryptedApiKey) {
      try {
        apiKey = decryptSecret(stored.encryptedApiKey);
      } catch {
        return res.status(500).json({ message: "The stored API key could not be decrypted. Re-enter and save your key." });
      }
    }
    if (!baseUrl) return res.status(400).json({ message: "Enter an API base URL first." });
    if (!apiKey) return res.status(400).json({ message: "Enter an API key first." });
    if (!model) return res.status(400).json({ message: "Enter the exact model ID before testing a model." });

    let normalizedBaseUrl;
    try {
      normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      assertAllowedProviderUrl(normalizedBaseUrl);
    } catch (error) {
      if (error instanceof ProviderError) {
        await recordTestResult(req.userId, stored, testStatusFor(error), error.code, error.message);
      }
      return providerErrorResponse(res, error);
    }

    try {
      const result = await testProviderModel({ baseUrl: normalizedBaseUrl, apiKey, providerType, model });
      const message = `Model "${model}" responded correctly. A small amount of provider tokens may have been used.`;
      await recordTestResult(req.userId, stored, "connected", "", message);
      return res.json({
        ok: true,
        message,
        sample: result.sample,
        availableModels: result.availableModels,
        modelChecked: true
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        await recordTestResult(req.userId, stored, testStatusFor(error), error.code, error.message);
        return res.status(400).json({ ok: false, message: error.message, code: error.code });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.put("/providers/:identifier/models", async (req, res, next) => {
  try {
    const identifier = String(req.params.identifier || "").trim().toLowerCase();
    const input = req.body || {};
    await connectToDatabase();
    const stored = await resolveStoredConfig(req.userId, identifier);
    if (!stored) return res.status(404).json({ message: "Save the configuration before managing its models." });

    let models = [];
    if (input.models !== undefined) {
      if (!Array.isArray(input.models) || input.models.length > 500) {
        return res.status(400).json({ message: "Models must be an array of at most 500 model IDs." });
      }
      models = [...new Set(input.models
        .filter(entry => typeof entry === "string")
        .map(entry => entry.trim())
        .filter(entry => entry.length > 0 && entry.length <= 200))];
      if (models.length !== input.models.filter(entry => typeof entry === "string" && entry.trim()).length) {
        return res.status(400).json({ message: "Every model ID must be a non-empty string of at most 200 characters." });
      }
    } else {
      models = stored.models;
    }

    let defaultModel = typeof input.defaultModel === "string" ? input.defaultModel.trim() : stored.defaultModel;
    if (defaultModel && !models.includes(defaultModel)) {
      return res.status(400).json({ message: "The default model must be one of the saved model IDs." });
    }

    const update = { models, defaultModel, model: defaultModel || stored.model };
    const config = await ProviderConfig.findOneAndUpdate(
      { _id: stored._id },
      { $set: update },
      { returnDocument: "after" }
    ).select("+encryptedApiKey");
    return res.json({ message: "Models saved.", config: publicConfig(config) });
  } catch (error) {
    return next(error);
  }
});

// ─── Legacy single-configuration compatibility ──────────────────────────────

router.get("/provider", async (req, res, next) => {
  try {
    await connectToDatabase();
    await ensureProviderIds(req.userId);
    const config = await loadActiveConfig(req.userId);
    return res.json({ config: publicConfig(config) });
  } catch (error) {
    return next(error);
  }
});

router.put("/provider", async (req, res, next) => {
  try {
    const input = req.body || {};
    await connectToDatabase();
    await ensureProviderIds(req.userId);
    // Legacy single-provider clients edit "their" configuration in place:
    // renaming a provider must keep the saved key and never create a duplicate.
    const existing = await loadActiveConfig(req.userId);
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const validationError = validateProviderFields(
      { provider: input.provider, baseUrl: input.baseUrl, apiKey, model: input.model ?? "" },
      { requireKey: !existing?.encryptedApiKey || apiKey.length > 0 }
    );
    if (validationError) return res.status(400).json({ message: validationError });
    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
    assertAllowedProviderUrl(normalizedBaseUrl);
    const providerId = existing?.providerId || providerIdFromName(input.provider);
    const update = {
      provider: input.provider.trim(),
      providerType: normalizeProviderType(input.providerType || existing?.providerType || "openai_compatible"),
      baseUrl: normalizedBaseUrl,
      model: typeof input.model === "string" ? input.model.trim() : existing?.model || ""
    };
    if (!existing) {
      update.providerId = providerId;
      update.configId = providerId;
    }
    if (apiKey.length > 0) update.encryptedApiKey = encryptSecret(apiKey);
    const filter = existing ? { userId: req.userId, _id: existing._id } : { userId: req.userId, configId: providerId };
    await ProviderConfig.findOneAndUpdate(
      filter,
      { $set: update, ...(existing ? {} : { $setOnInsert: { active: false, enabled: true, models: [], defaultModel: "" } }) },
      { upsert: true, setDefaultsOnInsert: true }
    );
    await activateProvider(req.userId, providerId);
    const saved = await ProviderConfig.findOne({ userId: req.userId, configId: providerId }).select("+encryptedApiKey");
    return res.json({ message: "Provider configuration saved.", config: publicConfig(saved) });
  } catch (error) {
    return providerErrorResponse(res, error) ?? next(error);
  }
});

router.delete("/provider", async (req, res, next) => {
  try {
    await connectToDatabase();
    await ensureProviderIds(req.userId);
    const active = await loadActiveConfig(req.userId);
    if (!active) return res.json({ message: "Provider configuration deleted." });
    await ProviderConfig.deleteOne({ _id: active._id });
    const fallback = await ProviderConfig.findOne({ userId: req.userId }).sort({ updatedAt: -1 });
    if (fallback) await activateProvider(req.userId, fallback.configId);
    return res.json({ message: "Provider configuration deleted." });
  } catch (error) {
    return next(error);
  }
});

router.post("/provider/test", async (req, res, next) => {
  try {
    const input = req.body || {};
    await connectToDatabase();
    await ensureProviderIds(req.userId);
    const stored = await loadActiveConfig(req.userId);
    const baseUrl = (input.baseUrl || stored?.baseUrl || "").trim();
    const providerType = normalizeProviderType(input.providerType || stored?.providerType);
    let apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey && stored?.encryptedApiKey) {
      try {
        apiKey = decryptSecret(stored.encryptedApiKey);
      } catch {
        return res.status(500).json({ message: "The stored API key could not be decrypted. Re-enter and save your key." });
      }
    }
    if (!baseUrl) return res.status(400).json({ message: "Enter an API base URL first." });
    if (!apiKey) return res.status(400).json({ message: "Enter an API key first." });

    let normalizedBaseUrl;
    try {
      normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      assertAllowedProviderUrl(normalizedBaseUrl);
    } catch (error) {
      if (error instanceof ProviderError && stored) {
        await recordTestResult(req.userId, stored, testStatusFor(error), error.code, error.message);
      }
      return providerErrorResponse(res, error);
    }

    try {
      const result = await testProviderConnection({ baseUrl: normalizedBaseUrl, apiKey, providerType });
      const parts = [result.listingSupported ? "Connection succeeded." : "Endpoint reached."];
      if (result.availableModels.length > 0) parts.push(`${result.availableModels.length} models available.`);
      else if (result.warning) parts.push(result.warning);
      const message = parts.join(" ");
      if (stored) await recordTestResult(req.userId, stored, result.listingSupported ? "connected" : "reachable", "", message);
      return res.json({
        ok: true,
        message,
        availableModels: result.availableModels,
        modelChecked: false,
        listingSupported: result.listingSupported,
        warning: result.warning
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        if (stored) await recordTestResult(req.userId, stored, testStatusFor(error), error.code, error.message);
        return res.status(400).json({ ok: false, message: error.message, code: error.code });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.post("/provider/test-model", async (req, res, next) => {
  try {
    const input = req.body || {};
    await connectToDatabase();
    await ensureProviderIds(req.userId);
    const stored = await loadActiveConfig(req.userId);
    const baseUrl = (input.baseUrl || stored?.baseUrl || "").trim();
    const model = String(input.model ?? stored?.defaultModel ?? stored?.model ?? "").trim();
    const providerType = normalizeProviderType(input.providerType || stored?.providerType);
    let apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey && stored?.encryptedApiKey) {
      try {
        apiKey = decryptSecret(stored.encryptedApiKey);
      } catch {
        return res.status(500).json({ message: "The stored API key could not be decrypted. Re-enter and save your key." });
      }
    }
    if (!baseUrl) return res.status(400).json({ message: "Enter an API base URL first." });
    if (!apiKey) return res.status(400).json({ message: "Enter an API key first." });
    if (!model) return res.status(400).json({ message: "Enter the exact model ID before testing a model." });

    let normalizedBaseUrl;
    try {
      normalizedBaseUrl = normalizeBaseUrl(baseUrl);
      assertAllowedProviderUrl(normalizedBaseUrl);
    } catch (error) {
      if (error instanceof ProviderError && stored) {
        await recordTestResult(req.userId, stored, testStatusFor(error), error.code, error.message);
      }
      return providerErrorResponse(res, error);
    }

    try {
      const result = await testProviderModel({ baseUrl: normalizedBaseUrl, apiKey, providerType, model });
      const message = `Model "${model}" responded correctly. A small amount of provider tokens may have been used.`;
      if (stored) await recordTestResult(req.userId, stored, "connected", "", message);
      return res.json({
        ok: true,
        message,
        sample: result.sample,
        availableModels: result.availableModels,
        modelChecked: true
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        if (stored) await recordTestResult(req.userId, stored, testStatusFor(error), error.code, error.message);
        return res.status(400).json({ ok: false, message: error.message, code: error.code });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.get("/shared-model", async (req, res, next) => {
  try {
    await connectToDatabase();
    return res.json({ shared: await sharedModelStatus() });
  } catch (error) {
    return next(error);
  }
});

// Safe connectivity check for the operator-configured OmniRoute gateway.
// Returns availability and counts only: never the base URL, API key, or
// upstream provider configuration.
router.get("/omniroute/status", async (req, res, next) => {
  try {
    await connectToDatabase();
    const omniroute = await checkOmniRoute();
    return res.json({ omniroute: publicOmniRouteStatus(omniroute) });
  } catch (error) {
    return next(error);
  }
});

router.get("/models", async (req, res, next) => {
  try {
    await connectToDatabase();
    const [shared, omniroute] = await Promise.all([sharedModelStatus(), checkOmniRoute()]);
    const sharedModels = Array.isArray(shared.models) ? shared.models : [];
    const sharedEntries = shared.available
      ? sharedModels
          .filter(model => model.available !== false)
          .map(model => ({ id: model.id, name: model.name || model.id, ownedBy: SHARED_OWNER_LABEL, shared: true, vision: model.vision === true }))
      : [];
    const sharedIds = new Set(sharedEntries.map(entry => entry.id));
    const omnirouteEntries = omnirouteModelRows(omniroute).filter(entry => !sharedIds.has(entry.id));
    const omniroutePublic = publicOmniRouteStatus(omniroute);

    await ensureProviderIds(req.userId);
    const requestedIdentifier = String(req.query.configId || req.query.providerId || "").trim().toLowerCase();

    // Focused listing (settings "Load models"): discovery for one saved
    // configuration only, with saved models preserved through outages.
    if (requestedIdentifier) {
      const stored = await resolveStoredConfig(req.userId, requestedIdentifier);
      if (!stored) return res.status(404).json({ message: "That configuration is not saved." });
      const savedEntries = savedModelRows(stored);
      const apiKey = await storedApiKey(stored);
      if (!apiKey) {
        if (savedEntries.length > 0) {
          return res.json({
            models: savedEntries,
            shared,
            configId: stored.configId,
            providerId: stored.providerId,
            warning: { message: "The stored API key could not be decrypted. Re-enter and save your key.", code: "key_decryption_failed" }
          });
        }
        return res.status(500).json({ message: "The stored API key could not be decrypted. Re-enter and save your key." });
      }
      try {
        const models = await listProviderModels({ baseUrl: stored.baseUrl, apiKey, providerType: stored.providerType });
        const liveEntries = models.map(model => ({
          ...model,
          name: model.name || model.id,
          shared: false,
          vision: null,
          saved: false,
          provider: stored.provider,
          providerId: stored.providerId,
          configId: stored.configId,
          apiKeyMasked: decryptedMask(stored)
        }));
        const merged = [...liveEntries, ...savedEntries.filter(entry => !liveEntries.some(live => live.id === entry.id))];
        return res.json({ models: merged, shared, configId: stored.configId, providerId: stored.providerId });
      } catch (error) {
        if (error instanceof ProviderError) {
          if (savedEntries.length > 0) {
            return res.json({
              models: savedEntries,
              shared,
              configId: stored.configId,
              providerId: stored.providerId,
              warning: { message: error.message, code: error.code }
            });
          }
          return res.status(400).json({ message: error.message, code: error.code, shared });
        }
        throw error;
      }
    }

    // Chat picker catalogue: the free/shared list and saved rows for EVERY
    // saved configuration, regardless of which one is active. The active
    // configuration may additionally be refreshed live, but a discovery
    // failure only adds a warning — saved rows and free models stay visible.
    const configs = await ensureProviderIds(req.userId);
    if (configs.length === 0 && sharedEntries.length === 0 && omnirouteEntries.length === 0) {
      return res.status(400).json({
        message: shared.enabled
          ? "The shared AI model is unavailable right now. Try again later or save your own provider configuration."
          : "The shared AI model is disabled. Save your own provider configuration to chat.",
        code: shared.enabled ? "shared_unavailable" : "shared_disabled",
        shared,
        omniroute: omniroutePublic
      });
    }

    const active = configs.find(config => config.active) ||
      configs.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] ||
      null;
    const personalRows = [];
    let warning = null;

    if (active) {
      const savedEntries = savedModelRows(active);
      const apiKey = await storedApiKey(active);
      if (!apiKey) {
        personalRows.push(...savedEntries);
        warning = { message: "The stored API key could not be decrypted. Re-enter and save your key.", code: "key_decryption_failed" };
      } else {
        try {
          const models = await listProviderModels({ baseUrl: active.baseUrl, apiKey, providerType: active.providerType });
          const liveEntries = models.map(model => ({
            ...model,
            name: model.name || model.id,
            shared: false,
            vision: null,
            saved: false,
            provider: active.provider,
            providerId: active.providerId,
            configId: active.configId,
            apiKeyMasked: decryptedMask(active)
          }));
          personalRows.push(
            ...liveEntries,
            ...savedEntries.filter(entry => !liveEntries.some(live => live.id === entry.id))
          );
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          personalRows.push(...savedEntries);
          warning = { message: error.message, code: error.code };
        }
      }
    }

    for (const config of configs) {
      if (active && config.configId === active.configId) continue;
      personalRows.push(...savedModelRows(config));
    }

    return res.json({
      models: [...sharedEntries, ...omnirouteEntries, ...personalRows],
      shared,
      omniroute: omniroutePublic,
      ...(warning ? { warning } : {})
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
