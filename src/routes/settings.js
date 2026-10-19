import { Router } from "express";
import connectToDatabase from "../db.js";
import ProviderConfig, { providerIdFromName } from "../providerConfig.js";
import { decryptSecret, encryptSecret, maskApiKey } from "../encryption.js";
import {
  ProviderError,
  assertAllowedProviderUrl,
  listProviderModels,
  normalizeBaseUrl,
  testProviderConnection,
  validateProviderFields
} from "../providerClient.js";
import { requireAuth, settingsRateLimiter } from "../middleware.js";
import { SHARED_OWNER_LABEL, sharedModelStatus } from "../sharedModel.js";

const router = Router();

router.use(requireAuth);
router.use(settingsRateLimiter);

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;

function publicConfig(config) {
  if (!config) {
    return {
      configured: false,
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
    apiKeyMasked: config.encryptedApiKey ? maskApiKey(decryptSecret(config.encryptedApiKey)) : "",
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

function testStatusFor(error) {
  if (error.code === "invalid_api_key") return "invalid_key";
  if (error.code === "insufficient_credits") return "insufficient_balance";
  if (error.code === "model_unavailable") return "model_unavailable";
  if (error.code === "timeout") return "timeout";
  if (error.code === "network_error" || error.code === "dns_error" || error.code === "connection_refused") return "unreachable";
  if (error.code === "local_endpoint" || error.code === "private_endpoint") return "unreachable";
  return "failed";
}

async function recordTestResult(userId, providerId, status, code, message) {
  try {
    await ProviderConfig.updateOne(
      { userId, providerId },
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
// support have no providerId. Derive a stable slug once and persist it without
// touching any other field.
async function ensureProviderIds(userId) {
  const configs = await ProviderConfig.find({ userId }).select("+encryptedApiKey");
  const taken = new Set(configs.map(config => config.providerId).filter(Boolean));
  for (const config of configs) {
    if (config.providerId) continue;
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
  return configs;
}

function providerErrorResponse(res, error) {
  if (error instanceof ProviderError) {
    return res.status(400).json({ message: error.message, code: error.code });
  }
  return null;
}

async function activateProvider(userId, providerId) {
  // Only the previously active provider is touched; every other provider
  // document (keys, URLs, models, defaults, timestamps) stays untouched.
  await ProviderConfig.updateMany({ userId, providerId: { $ne: providerId }, active: true }, { $set: { active: false } });
  return ProviderConfig.findOneAndUpdate(
    { userId, providerId },
    { $set: { active: true } },
    { returnDocument: "after" }
  );
}

// ─── Multi-provider management ──────────────────────────────────────────────

router.get("/providers", async (req, res, next) => {
  try {
    await connectToDatabase();
    const configs = await ensureProviderIds(req.userId);
    let activeProviderId = configs.find(config => config.active)?.providerId || "";
    if (!activeProviderId && configs.length > 0) {
      const newest = configs.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
      await activateProvider(req.userId, newest.providerId);
      activeProviderId = newest.providerId;
      const marked = configs.find(config => config.providerId === newest.providerId);
      if (marked) marked.active = true;
    }
    const providers = configs
      .slice()
      .sort((a, b) => Number(b.active) - Number(a.active) || new Date(b.updatedAt) - new Date(a.updatedAt))
      .map(publicConfig);
    return res.json({ providers, activeProviderId });
  } catch (error) {
    return next(error);
  }
});

router.put("/providers/:providerId", async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || "").trim().toLowerCase();
    if (!PROVIDER_ID_PATTERN.test(providerId)) {
      return res.status(400).json({ message: "Provider id must be a lowercase slug such as \"flagshiprouter\"." });
    }
    const input = req.body || {};
    await connectToDatabase();
    const existing = await ProviderConfig.findOne({ userId: req.userId, providerId }).select("+encryptedApiKey");
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const validationError = validateProviderFields(
      { provider: input.provider, baseUrl: input.baseUrl, apiKey, model: input.model ?? "" },
      { requireKey: !existing?.encryptedApiKey || apiKey.length > 0 }
    );
    if (validationError) return res.status(400).json({ message: validationError });

    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
    assertAllowedProviderUrl(normalizedBaseUrl);

    const providerType = ["openai_compatible", "anthropic_compatible", "native", "local_gateway"].includes(input.providerType)
      ? input.providerType
      : existing?.providerType || "openai_compatible";
    const update = {
      providerId,
      provider: input.provider.trim(),
      providerType,
      baseUrl: normalizedBaseUrl,
      model: typeof input.model === "string" ? input.model.trim() : existing?.model || ""
    };
    if (apiKey.length > 0) update.encryptedApiKey = encryptSecret(apiKey);

    let config;
    try {
      config = await ProviderConfig.findOneAndUpdate(
        { userId: req.userId, providerId },
        {
          $set: update,
          ...(existing ? {} : { $setOnInsert: { active: false, enabled: true, models: [], defaultModel: "" } })
        },
        { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
      ).select("+encryptedApiKey");
    } catch (error) {
      if (error?.code !== 11000) throw error;
      config = await ProviderConfig.findOneAndUpdate(
        { userId: req.userId, providerId },
        { $set: update },
        { returnDocument: "after" }
      ).select("+encryptedApiKey");
    }

    // A brand-new provider becomes the selected one; editing an existing
    // provider never steals the active selection from another provider.
    if (!existing) {
      await activateProvider(req.userId, providerId);
      config = await ProviderConfig.findOne({ userId: req.userId, providerId }).select("+encryptedApiKey");
    }
    return res.json({ message: `${config.provider} saved.`, config: publicConfig(config) });
  } catch (error) {
    return providerErrorResponse(res, error) ?? next(error);
  }
});

router.post("/providers/:providerId/activate", async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || "").trim().toLowerCase();
    await connectToDatabase();
    const config = await activateProvider(req.userId, providerId);
    if (!config) return res.status(404).json({ message: "That provider is not saved." });
    return res.json({ message: `${config.provider} is now the selected provider.`, providerId });
  } catch (error) {
    return next(error);
  }
});

router.delete("/providers/:providerId", async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || "").trim().toLowerCase();
    await connectToDatabase();
    const deleted = await ProviderConfig.findOneAndDelete({ userId: req.userId, providerId });
    if (!deleted) return res.status(404).json({ message: "That provider is not saved." });
    if (deleted.active) {
      const fallback = await ProviderConfig.findOne({ userId: req.userId }).sort({ updatedAt: -1 });
      if (fallback) await activateProvider(req.userId, fallback.providerId);
    }
    return res.json({ message: `${deleted.provider} was removed.` });
  } catch (error) {
    return next(error);
  }
});

router.post("/providers/:providerId/test", async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || "").trim().toLowerCase();
    const input = req.body || {};
    await connectToDatabase();
    const stored = await ProviderConfig.findOne({ userId: req.userId, providerId }).select("+encryptedApiKey");
    const baseUrl = (input.baseUrl || stored?.baseUrl || "").trim();
    const model = String(input.model ?? stored?.defaultModel ?? stored?.model ?? "").trim();
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
        await recordTestResult(req.userId, providerId, testStatusFor(error), error.code, error.message);
      }
      return providerErrorResponse(res, error);
    }

    try {
      const result = await testProviderConnection({ baseUrl: normalizedBaseUrl, apiKey, model });
      const parts = ["Connection succeeded."];
      if (result.modelChecked) parts.push(`Model "${model}" responded correctly.`);
      if (result.availableModels.length > 0) {
        parts.push(`${result.availableModels.length} models available.`);
        if (stored && stored.models.length === 0) {
          // First successful discovery: persist the list so it survives later
          // outages. Never erases a list that already exists.
          await ProviderConfig.updateOne(
            { userId: req.userId, providerId, models: { $size: 0 } },
            { $set: { models: result.availableModels.map(entry => entry.id).slice(0, 500) } }
          );
        }
      }
      const message = parts.join(" ");
      if (stored) await recordTestResult(req.userId, providerId, "connected", "", message);
      return res.json({
        ok: true,
        message,
        availableModels: result.availableModels,
        modelChecked: result.modelChecked
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        if (stored) await recordTestResult(req.userId, providerId, testStatusFor(error), error.code, error.message);
        return res.status(400).json({ ok: false, message: error.message, code: error.code });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

router.put("/providers/:providerId/models", async (req, res, next) => {
  try {
    const providerId = String(req.params.providerId || "").trim().toLowerCase();
    const input = req.body || {};
    await connectToDatabase();
    const stored = await ProviderConfig.findOne({ userId: req.userId, providerId }).select("+encryptedApiKey");
    if (!stored) return res.status(404).json({ message: "Save the provider before managing its models." });

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
      { userId: req.userId, providerId },
      { $set: update },
      { returnDocument: "after" }
    ).select("+encryptedApiKey");
    return res.json({ message: "Models saved.", config: publicConfig(config) });
  } catch (error) {
    return next(error);
  }
});

// ─── Legacy single-provider compatibility ───────────────────────────────────

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
    const providerId = existing?.providerId || providerIdFromName(input.provider);
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const validationError = validateProviderFields(
      { provider: input.provider, baseUrl: input.baseUrl, apiKey, model: input.model ?? "" },
      { requireKey: !existing?.encryptedApiKey || apiKey.length > 0 }
    );
    if (validationError) return res.status(400).json({ message: validationError });
    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
    assertAllowedProviderUrl(normalizedBaseUrl);
    const update = {
      provider: input.provider.trim(),
      providerType: existing?.providerType || "openai_compatible",
      baseUrl: normalizedBaseUrl,
      model: typeof input.model === "string" ? input.model.trim() : existing?.model || ""
    };
    if (!existing) update.providerId = providerId;
    if (apiKey.length > 0) update.encryptedApiKey = encryptSecret(apiKey);
    const filter = existing ? { userId: req.userId, _id: existing._id } : { userId: req.userId, providerId };
    await ProviderConfig.findOneAndUpdate(
      filter,
      { $set: update, ...(existing ? {} : { $setOnInsert: { active: false, enabled: true, models: [], defaultModel: "" } }) },
      { upsert: true, setDefaultsOnInsert: true }
    );
    await activateProvider(req.userId, providerId);
    const saved = await ProviderConfig.findOne({ userId: req.userId, providerId }).select("+encryptedApiKey");
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
    if (fallback) await activateProvider(req.userId, fallback.providerId);
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
    const model = String(input.model ?? stored?.defaultModel ?? stored?.model ?? "").trim();
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
        await recordTestResult(req.userId, stored.providerId, testStatusFor(error), error.code, error.message);
      }
      return providerErrorResponse(res, error);
    }

    try {
      const result = await testProviderConnection({ baseUrl: normalizedBaseUrl, apiKey, model });
      const parts = ["Connection succeeded."];
      if (result.modelChecked) parts.push(`Model "${model}" responded correctly.`);
      if (result.availableModels.length > 0) parts.push(`${result.availableModels.length} models available.`);
      const message = parts.join(" ");
      if (stored) await recordTestResult(req.userId, stored.providerId, "connected", "", message);
      return res.json({ ok: true, message, availableModels: result.availableModels, modelChecked: result.modelChecked });
    } catch (error) {
      if (error instanceof ProviderError) {
        if (stored) await recordTestResult(req.userId, stored.providerId, testStatusFor(error), error.code, error.message);
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

router.get("/models", async (req, res, next) => {
  try {
    await connectToDatabase();
    const shared = await sharedModelStatus();
    const sharedModels = Array.isArray(shared.models) ? shared.models : [];
    const sharedEntries = shared.available
      ? sharedModels
          .filter(model => model.available !== false)
          .map(model => ({ id: model.id, name: model.name || model.id, ownedBy: SHARED_OWNER_LABEL, shared: true, vision: model.vision === true }))
      : [];
    await ensureProviderIds(req.userId);
    const requestedProviderId = typeof req.query.providerId === "string" ? req.query.providerId.trim().toLowerCase() : "";
    const stored = requestedProviderId
      ? await ProviderConfig.findOne({ userId: req.userId, providerId: requestedProviderId }).select("+encryptedApiKey")
      : await loadActiveConfig(req.userId);
    if (!stored && requestedProviderId) {
      return res.status(404).json({ message: "That provider is not saved." });
    }
    if (!stored) {
      if (sharedEntries.length === 0) {
        return res.status(400).json({
          message: shared.enabled
            ? "The shared AI model is unavailable right now. Try again later or save your own provider configuration."
            : "The shared AI model is disabled. Save your own provider configuration to chat.",
          code: shared.enabled ? "shared_unavailable" : "shared_disabled",
          shared
        });
      }
      return res.json({ models: sharedEntries, shared });
    }
    let apiKey;
    try {
      apiKey = decryptSecret(stored.encryptedApiKey);
    } catch {
      return res.status(500).json({ message: "The stored API key could not be decrypted. Re-enter and save your key." });
    }

    const savedEntries = (stored.models || []).map(id => ({
      id,
      name: id,
      ownedBy: stored.provider,
      shared: false,
      vision: null,
      providerId: stored.providerId,
      saved: true
    }));
    try {
      const models = await listProviderModels({ baseUrl: stored.baseUrl, apiKey });
      const personal = models.map(model => ({
        ...model,
        name: model.name || model.id,
        shared: false,
        vision: null,
        providerId: stored.providerId
      }));
      const merged = [...sharedEntries, ...personal.filter(model => !sharedEntries.some(entry => entry.id === model.id))];
      return res.json({ models: merged, shared, providerId: stored.providerId });
    } catch (error) {
      if (error instanceof ProviderError) {
        // Discovery failed. Saved models must survive provider outages, so
        // return them instead of erasing the list the user configured.
        if (savedEntries.length > 0) {
          const merged = [...sharedEntries, ...savedEntries.filter(model => !sharedEntries.some(entry => entry.id === model.id))];
          return res.json({ models: merged, shared, providerId: stored.providerId, warning: { message: error.message, code: error.code } });
        }
        return res.status(400).json({ message: error.message, code: error.code, shared });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

export default router;
