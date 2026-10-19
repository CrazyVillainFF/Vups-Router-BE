import { Router } from "express";
import connectToDatabase from "../db.js";
import ProviderConfig from "../providerConfig.js";
import { decryptSecret, encryptSecret, maskApiKey } from "../encryption.js";
import {
  ProviderError,
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

function publicConfig(config) {
  if (!config) {
    return { configured: false, provider: "", baseUrl: "", model: "", hasApiKey: false, apiKeyMasked: "", lastTest: null };
  }
  return {
    configured: true,
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model || "",
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
  if (error.code === "network_error") return "unreachable";
  return "failed";
}

async function recordTestResult(userId, status, code, message) {
  try {
    await ProviderConfig.updateOne(
      { userId },
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

async function loadStoredConfig(userId) {
  return ProviderConfig.findOne({ userId }).select("+encryptedApiKey");
}

function providerErrorResponse(res, error) {
  if (error instanceof ProviderError) {
    return res.status(400).json({ message: error.message, code: error.code });
  }
  return null;
}

router.get("/provider", async (req, res, next) => {
  try {
    await connectToDatabase();
    const config = await loadStoredConfig(req.userId);
    return res.json({ config: publicConfig(config) });
  } catch (error) {
    return next(error);
  }
});

router.put("/provider", async (req, res, next) => {
  try {
    const input = req.body || {};
    await connectToDatabase();
    const stored = await loadStoredConfig(req.userId);
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const hasStoredKey = Boolean(stored?.encryptedApiKey);
    const validationError = validateProviderFields(
      {
        provider: input.provider,
        baseUrl: input.baseUrl,
        apiKey,
        model: input.model
      },
      { requireKey: !hasStoredKey || apiKey.length > 0 }
    );
    if (validationError) return res.status(400).json({ message: validationError });
    const update = {
      provider: input.provider.trim(),
      baseUrl: normalizeBaseUrl(input.baseUrl),
      model: (input.model || "").trim()
    };
    if (apiKey.length > 0) update.encryptedApiKey = encryptSecret(apiKey);
    const config = await ProviderConfig.findOneAndUpdate(
      { userId: req.userId },
      { $set: update },
      { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
    ).select("+encryptedApiKey");
    return res.json({ message: "Provider configuration saved.", config: publicConfig(config) });
  } catch (error) {
    return providerErrorResponse(res, error) ?? next(error);
  }
});

router.delete("/provider", async (req, res, next) => {
  try {
    await connectToDatabase();
    await ProviderConfig.deleteOne({ userId: req.userId });
    return res.json({ message: "Provider configuration deleted." });
  } catch (error) {
    return next(error);
  }
});

router.post("/provider/test", async (req, res, next) => {
  try {
    const input = req.body || {};
    await connectToDatabase();
    const stored = await loadStoredConfig(req.userId);
    const baseUrl = (input.baseUrl || stored?.baseUrl || "").trim();
    const model = (input.model ?? stored?.model ?? "").trim();
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
    try {
      normalizeBaseUrl(baseUrl);
    } catch (error) {
      return providerErrorResponse(res, error);
    }

    try {
      const result = await testProviderConnection({ baseUrl: normalizeBaseUrl(baseUrl), apiKey, model });
      const parts = ["Connection succeeded."];
      if (result.modelChecked) parts.push(`Model "${model}" responded correctly.`);
      if (result.availableModels.length > 0) parts.push(`${result.availableModels.length} models available.`);
      const message = parts.join(" ");
      await recordTestResult(req.userId, "connected", "", message);
      return res.json({
        ok: true,
        message,
        availableModels: result.availableModels,
        modelChecked: result.modelChecked
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        await recordTestResult(req.userId, testStatusFor(error), error.code, error.message);
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
    const sharedEntry = shared.available
      ? [{ id: shared.model, ownedBy: SHARED_OWNER_LABEL, shared: true }]
      : [];
    const stored = await loadStoredConfig(req.userId);
    if (!stored) {
      if (sharedEntry.length === 0) {
        return res.status(400).json({
          message: shared.enabled
            ? "The shared AI model is unavailable right now. Try again later or save your own provider configuration."
            : "The shared AI model is disabled. Save your own provider configuration to chat.",
          code: shared.enabled ? "shared_unavailable" : "shared_disabled",
          shared
        });
      }
      return res.json({ models: sharedEntry, shared });
    }
    let apiKey;
    try {
      apiKey = decryptSecret(stored.encryptedApiKey);
    } catch {
      return res.status(500).json({ message: "The stored API key could not be decrypted. Re-enter and save your key." });
    }
    try {
      const models = await listProviderModels({ baseUrl: stored.baseUrl, apiKey });
      const merged = [...models, ...sharedEntry.filter(entry => !models.some(model => model.id === entry.id))];
      return res.json({ models: merged, shared });
    } catch (error) {
      if (error instanceof ProviderError) {
        return res.status(400).json({ message: error.message, code: error.code, shared });
      }
      throw error;
    }
  } catch (error) {
    return next(error);
  }
});

export default router;
