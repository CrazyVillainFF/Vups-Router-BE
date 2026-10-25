import { Router } from "express";
import mongoose from "mongoose";
import connectToDatabase, { isDatabaseFailure } from "../db.js";
import ProviderConfig from "../providerConfig.js";
import Conversation from "../conversation.js";
import { decryptSecret } from "../encryption.js";
import {
  ProviderError,
  assertAllowedProviderUrl,
  chatCompletion,
  extractStreamText,
  isQuotaExhaustedError,
  normalizeBaseUrl,
  redactSecrets,
  startChatCompletionStream,
  withProviderRetry
} from "../providerClient.js";
import { chatRateLimiter, requireAuth, vupsGalaxRateLimiter } from "../middleware.js";
import { UsageError, acquireSlot, consumeDailyQuota, releaseSlot } from "../usage.js";
import { sharedModelStatus, sharedProviderForChat } from "../sharedModel.js";
import { resolveOmniRouteChat } from "../omniroute.js";
import { attachmentMetadata, validateImages } from "../chatImages.js";
import {
  VUPS_MODEL_ID,
  buildVupsSystemPrompt,
  normalizeVupsMode,
  vupsProviderForChat
} from "../vupsGalax.js";

const router = Router();

const SYSTEM_PROMPT =
  "You are the VupsRouter AI assistant. VupsRouter helps developers and users explore AI models — hosted providers, OpenAI-compatible APIs, and locally-run open-weight models. Be concise, helpful, and honest about model limitations. Use markdown when it improves clarity. Do not pretend to know real-time facts you do not have. For large projects or multi-file code (for example a full marketplace app), organize the answer into named files/modules and generate them in manageable stages instead of promising an entire complex project in one reply. When the output limit is near, stop at a natural boundary and tell the user which files remain so they can continue. For downloadable multi-file projects, put a line in the exact form `FILE: relative/path.ext` immediately before each fenced code block so the client can package the real files; use safe relative paths and never invent files.";

const MOTION_DESIGN_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

You are currently in Motion Design mode. Act as a senior creative frontend engineer and motion designer. Help users plan, implement, explain, and debug production-quality web motion.

Priorities:
- Prefer GSAP timelines and ScrollTrigger for complex sequencing and scroll-linked motion. Use @gsap/react when the project uses React, and clean up timelines, ScrollTriggers, and listeners in effect cleanup.
- Use CSS transitions/keyframes for simple state changes and microinteractions. Suggest Framer Motion/Motion for React only when its component model is a better fit. Use SVG animation for paths, drawing, and typography. Use Three.js/React Three Fiber only when the requested result justifies the cost and the hardware budget.
- Start with the simplest technique that achieves the visual result. Do not add libraries or animate every element. Avoid generic layouts, decorative clutter, excessive gradients, and motion that harms readability.
- Produce complete, runnable code with exact file paths, imports, and integration steps. If repository tools are available, inspect and modify the real files, then run the relevant checks. If they are not available, say so and give copy-ready code instead of claiming changes were made.
- Respect prefers-reduced-motion, keyboard access, touch input, resizing, and mobile performance. Prefer transform and opacity, avoid layout thrashing, horizontal overflow, scroll traps, and broken pinning.
- Check cleanup, stacking contexts, clipping, layout shift, animation timing, and GPU cost when debugging.
- Never claim code was executed, tested, deployed, or visually verified unless it actually was. State remaining limitations and the exact commands the user must run.`;

const CHAT_MODES = new Map([
  ["general", SYSTEM_PROMPT],
  ["motion", MOTION_DESIGN_SYSTEM_PROMPT]
]);

const MAX_MESSAGES = 60;
const MAX_TOTAL_CHARS = 120000;
const MAX_STORED_MESSAGES = 200;
const MAX_UPSTREAM_TEXT_CHARS = 2_000_000;

function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0) return "messages must be a non-empty array.";
  if (value.length > MAX_MESSAGES) return `A request can contain at most ${MAX_MESSAGES} messages.`;
  const messages = [];
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const role = entry?.role;
    const content = typeof entry?.content === "string" ? entry.content : "";
    if (role !== "user" && role !== "assistant") return "Every message needs a role of user or assistant.";
    if (content.length > 32000) return "A single message cannot exceed 32000 characters.";
    const images = validateImages(entry?.images);
    if (images.error) return images.error;
    if (images.images.length > 0) {
      if (index !== value.length - 1) return "Images can only be attached to the current message.";
      if (role !== "user") return "Images can only be attached to your own messages.";
    }
    if (content.trim().length === 0 && images.images.length === 0) return "Message content cannot be empty.";
    total += content.length;
    if (total > MAX_TOTAL_CHARS) return "The conversation is too large. Start a new chat or shorten your messages.";
    if (images.images.length > 0) {
      messages.push({ role, content, images: images.images, attachmentMeta: attachmentMetadata(images.images) });
    } else {
      messages.push({ role, content });
    }
  }
  if (messages[messages.length - 1].role !== "user") return "The last message must come from the user.";
  return { messages };
}

const SHARED_UNAVAILABLE_MESSAGES = {
  not_configured: "The shared AI model is not configured on this server. Configure your own provider in API settings.",
  unreachable: "The shared AI model server is unreachable right now. Please try again later or use your own provider.",
  unauthorized: "The shared free-model catalog rejected this server's OpenRouter key. Ask the administrator to verify OPENROUTER_API_KEY.",
  rate_limited: "The shared free-model catalog is rate-limited right now. Please try again later or use your own provider.",
  empty: "The shared free-model catalog returned no usable models. Please try again later or use your own provider.",
  invalid_response: "The shared free-model catalog returned an invalid response. Please try again later or use your own provider.",
  missing_model: "The shared model is not installed or is not available from the free catalog. Please try again later or use your own provider."
};

function sharedModelsOf(shared) {
  if (Array.isArray(shared?.models) && shared.models.length > 0) return shared.models;
  return shared?.model ? [{ id: shared.model, name: shared.model, available: shared.available !== false }] : [];
}

function sharedRoute(shared, requestedModel = "") {
  if (!shared.enabled) {
    throw new ProviderError(
      "The shared AI model has been disabled by an administrator. Configure your own provider in API settings or try again later.",
      403,
      "shared_disabled"
    );
  }
  if (!shared.available) {
    throw new ProviderError(
      SHARED_UNAVAILABLE_MESSAGES[shared.status] ?? "The shared AI model is unavailable right now. Please try again later.",
      503,
      "shared_unavailable"
    );
  }
  const provider = sharedProviderForChat();
  if (!provider) {
    throw new ProviderError("The shared AI model is not configured on this server.", 503, "shared_unavailable");
  }
  const enabledModels = sharedModelsOf(shared);
  const readyIds = enabledModels.filter(model => model.available !== false).map(model => model.id);
  if (readyIds.length === 0) {
    throw new ProviderError(
      "The shared AI models are unavailable right now. Please try again later or use your own provider.",
      503,
      "shared_unavailable"
    );
  }
  const offeredIds = readyIds.slice(0, 20).join(", ");
  const offeredSuffix = readyIds.length > 20 ? ` (and ${readyIds.length - 20} more)` : "";
  let model;
  if (requestedModel) {
    if (readyIds.includes(requestedModel)) {
      model = requestedModel;
    } else if (enabledModels.some(entry => entry.id === requestedModel)) {
      throw new ProviderError(
        `That shared model is not available right now. Pick another shared model (${offeredIds}${offeredSuffix}) or try again later.`,
        503,
        "shared_model_unavailable"
      );
    } else {
      throw new ProviderError(
        `"${requestedModel.slice(0, 80)}" is not an enabled shared model. Choose one of: ${offeredIds}${offeredSuffix}.`,
        400,
        "invalid_model"
      );
    }
  } else {
    model = shared.model && readyIds.includes(shared.model) ? shared.model : readyIds[0];
  }
  const freeReadyIds = enabledModels
    .filter(entry => entry.available !== false && entry.free === true)
    .map(entry => entry.id);
  const configuredFallback =
    shared.fallbackModel && shared.fallbackModel !== model && freeReadyIds.includes(shared.fallbackModel)
      ? shared.fallbackModel
      : null;
  const fallbackModel = configuredFallback || freeReadyIds.find(id => id !== model) || null;
  const visionModelIds = enabledModels
    .filter(entry => entry.available !== false && entry.vision === true)
    .map(entry => entry.id);
  return {
    shared: true,
    provider: provider.provider,
    providerType: provider.providerType || "openai_compatible",
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    defaultModel: model,
    fallbackModel,
    maxTokens: provider.maxTokens,
    reasoning: provider.reasoning,
    visionModelIds
  };
}

function configOffersModel(config, model) {
  if (!model) return true;
  if (config.model === model) return true;
  const savedModels = Array.isArray(config.models) ? config.models : [];
  if (savedModels.length === 0) return true;
  return savedModels.includes(model);
}

function chooseSavedConfig(candidates) {
  if (candidates.length === 0) return { config: null, reason: "none" };
  const active = candidates.filter(candidate => candidate.active === true);
  if (active.length === 1) return { config: active[0], reason: null };
  if (active.length > 1 || candidates.length > 1) return { config: null, reason: "ambiguous" };
  return { config: candidates[0], reason: null };
}

async function resolveProvider(userId, requestedModel, requestedConfigId, requestedSource = "", requestedProviderId = "") {
  // A gateway source is an explicit, whitelisted selection from the model
  // picker. Client input can never choose an upstream URL.
  if (requestedSource) {
    if (requestedSource !== "omniroute") {
      throw new ProviderError("Unknown model source. Pick a model from the model menu.", 400, "invalid_source");
    }
    if (requestedConfigId) {
      throw new ProviderError("A gateway model cannot be combined with a saved configuration.", 400, "invalid_source");
    }
    return resolveOmniRouteChat(requestedModel);
  }

  const shared = await sharedModelStatusSafely();
  let config = null;

  // An explicit configuration reference identifies the exact saved row, so
  // duplicate model names in different configurations can never cross keys.
  if (requestedConfigId) {
    config =
      (await ProviderConfig.findOne({ userId, configId: requestedConfigId }).select("+encryptedApiKey")) ||
      (await ProviderConfig.findOne({ userId, providerId: requestedConfigId })
        .sort({ active: -1, updatedAt: -1 })
        .select("+encryptedApiKey"));
    if (!config) {
      throw new ProviderError(
        "That saved configuration was removed. Pick another model from the model menu.",
        404,
        "config_not_found"
      );
    }
    if (requestedProviderId && config.providerId !== requestedProviderId) {
      throw new ProviderError(
        "The selected provider does not match that saved configuration. Refresh the model menu and pick it again.",
        400,
        "provider_mismatch"
      );
    }
  }

  const sharedIds = new Set(sharedModelsOf(shared).map(model => model.id));
  if (!requestedConfigId) {
    if (requestedProviderId) {
      const savedConfigs = await ProviderConfig.find({ userId })
        .sort({ active: -1, updatedAt: -1 })
        .select("+encryptedApiKey");
      const providerConfigs = savedConfigs.filter(candidate => candidate.providerId === requestedProviderId);
      if (providerConfigs.length === 0) {
        throw new ProviderError(
          "That saved provider was removed. Pick another model from the model menu.",
          404,
          "config_not_found"
        );
      }
      const candidates = requestedModel
        ? providerConfigs.filter(candidate => configOffersModel(candidate, requestedModel))
        : providerConfigs;
      if (candidates.length === 0) {
        throw new ProviderError(
          `"${requestedModel.slice(0, 80)}" is not one of your saved models for that provider. Refresh the model menu and choose a saved model.`,
          400,
          "invalid_model"
        );
      }
      const chosen = chooseSavedConfig(candidates);
      if (!chosen.config) {
        throw new ProviderError(
          "More than one saved provider matches that model. Choose the exact saved model from the model menu.",
          409,
          "ambiguous_model"
        );
      }
      config = chosen.config;
    } else if (requestedModel && sharedIds.has(requestedModel)) {
      return sharedRoute(shared, requestedModel);
    } else if (requestedModel) {
      // Never infer a provider from an unrelated active configuration. The
      // requested model must belong to the configuration we use.
      const candidates = (await ProviderConfig.find({ userId })
        .sort({ active: -1, updatedAt: -1 })
        .select("+encryptedApiKey"))
        .filter(candidate => configOffersModel(candidate, requestedModel));
      if (candidates.length === 0) {
        if (shared.enabled && shared.available) return sharedRoute(shared, requestedModel);
        throw new ProviderError(
          "That model does not belong to any saved provider. Choose a model from the model menu or add it in settings.",
          400,
          "invalid_model"
        );
      }
      const chosen = chooseSavedConfig(candidates);
      if (!chosen.config) {
        throw new ProviderError(
          "More than one saved provider has that model. Choose the exact saved model from the model menu.",
          409,
          "ambiguous_model"
        );
      }
      config = chosen.config;
    } else {
      config =
        (await ProviderConfig.findOne({ userId, active: true }).select("+encryptedApiKey")) ||
        (await ProviderConfig.findOne({ userId }).sort({ updatedAt: -1 }).select("+encryptedApiKey"));
    }
  }
  if (!config) {
    return sharedRoute(shared, requestedModel);
  }
  if (config.enabled === false) {
    throw new ProviderError(
      `Your saved provider "${config.provider}" is disabled. Enable it in Providers settings or select another provider.`,
      403,
      "provider_disabled"
    );
  }
  const savedModelIds = Array.isArray(config.models) ? config.models : [];
  if (requestedModel && savedModelIds.length > 0 && !savedModelIds.includes(requestedModel) && requestedModel !== config.model) {
    throw new ProviderError(
      `"${requestedModel.slice(0, 80)}" is not one of your saved models for ${config.provider}. Add it in Models settings or choose a saved model.`,
      400,
      "invalid_model"
    );
  }
  let apiKey;
  try {
    apiKey = decryptSecret(config.encryptedApiKey);
  } catch {
    throw new ProviderError("The stored API key could not be decrypted. Re-enter and save your key in Settings.", 500, "key_decryption_failed");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  assertAllowedProviderUrl(baseUrl);
  return {
    shared: false,
    provider: config.provider,
    providerType: config.providerType || "openai_compatible",
    configId: config.configId,
    providerId: config.providerId,
    baseUrl,
    defaultModel: config.defaultModel || config.model || "",
    apiKey,
    maxTokens: undefined
  };
}

async function sharedModelStatusSafely() {
  const fallback = {
    enabled: true,
    provider: "unavailable",
    model: "",
    available: false,
    status: "unreachable",
    models: []
  };
  try {
    return await sharedModelStatus();
  } catch (error) {
    if (isDatabaseFailure(error)) throw error;
    console.error("Shared model status check failed:", error?.name || "UnknownError");
    return fallback;
  }
}

// Chat history keeps attachment metadata only — image bytes are never stored.
function storedMessage(message) {
  if (Array.isArray(message.attachmentMeta) && message.attachmentMeta.length > 0) {
    return { role: message.role, content: message.content, attachments: message.attachmentMeta };
  }
  return { role: message.role, content: message.content };
}

async function persistConversation(userId, conversationId, messages, assistantText) {
  const storedMessages = [...messages.map(storedMessage), { role: "assistant", content: assistantText }].slice(-MAX_STORED_MESSAGES);
  const firstUser = storedMessages.find(message => message.role === "user");
  const titleSource = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
  const fallbackTitle = Array.isArray(firstUser?.attachments) && firstUser.attachments.length > 0 ? "Image attachment" : "New chat";
  const title = (titleSource || fallbackTitle).slice(0, 60);
  let conversation = null;
  if (conversationId && mongoose.isValidObjectId(conversationId)) {
    conversation = await Conversation.findOne({ _id: conversationId, userId });
  }
  if (!conversation) {
    const reuseId = conversationId && mongoose.isValidObjectId(conversationId) ? { _id: conversationId } : {};
    conversation = new Conversation({ ...reuseId, userId, title, messages: storedMessages });
  } else {
    conversation.messages = storedMessages;
    if (!conversation.title) conversation.title = title;
  }
  try {
    await conversation.save();
  } catch (error) {
    if (error?.code === 11000 && conversation.isNew) {
      conversation = new Conversation({ userId, title, messages: storedMessages });
      await conversation.save();
    } else {
      throw error;
    }
  }
  return conversation;
}

function sendEvent(res, payload) {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const PROVIDER_STATUS_BY_CODE = {
  bad_request: 400,
  not_found: 404,
  method_not_allowed: 502,
  invalid_api_key: 401,
  insufficient_credits: 402,
  forbidden: 403,
  too_large: 413,
  unprocessable: 422,
  local_endpoint: 400,
  private_endpoint: 400,
  unsafe_redirect: 400,
  missing_project_id: 400,
  unsupported_protocol: 400,
  free_tier_client_only: 403,
  free_quota_exhausted: 429,
  quota_exhausted: 429,
  region_restricted: 403,
  model_unavailable: 400,
  dns_error: 502,
  connection_refused: 502,
  provider_disabled: 403,
  invalid_model: 400,
  rate_limited: 429,
  timeout: 504,
  provider_unavailable: 502,
  network_error: 502,
  empty_response: 502,
  empty_stream: 502,
  response_too_large: 413,
  stream_error: 502
};

function providerFailureStatus(error) {
  if (error?.code && PROVIDER_STATUS_BY_CODE[error.code]) return PROVIDER_STATUS_BY_CODE[error.code];
  if (typeof error?.status === "number" && error.status >= 400 && error.status <= 599) return error.status;
  return 502;
}

function sendProviderFailure(res, failure, error, requestId = null) {
  if (Number.isInteger(error?.retryAfter) && error.retryAfter >= 0) {
    res.setHeader("Retry-After", String(error.retryAfter));
  }
  return res.status(failure.status).json({
    message: failure.message,
    code: failure.code,
    ...(requestId ? { requestId } : {})
  });
}

function providerFailure(provider, error) {
  if (provider?.gateway) {
    if (error.code === "invalid_api_key" || error.code === "forbidden") {
      return {
        status: 503,
        message: "OmniRoute rejected the API key configured on this server. Ask the administrator to verify OMNIROUTE_API_KEY.",
        code: "omniroute_auth_failed"
      };
    }
    if (error.code === "insufficient_credits") {
      return {
        status: 402,
        message: "OmniRoute reports insufficient credits for this request. Try again later or pick another model.",
        code: "omniroute_insufficient_credits"
      };
    }
    if (error.code === "rate_limited") {
      return {
        status: 429,
        message: "OmniRoute or its upstream provider is rate-limiting requests. Try again shortly or pick another model.",
        code: "omniroute_rate_limited"
      };
    }
    if (error.code === "timeout") {
      return {
        status: 504,
        message: "Timed out while waiting for OmniRoute. Try again shortly or pick another model.",
        code: "omniroute_timeout"
      };
    }
    if (["network_error", "dns_error", "connection_refused"].includes(error.code)) {
      return {
        status: 502,
        message: "OmniRoute could not be reached right now. Try again shortly or pick another model.",
        code: "omniroute_unreachable"
      };
    }
    if (error.code === "invalid_model" || error.code === "not_found") {
      return {
        status: 400,
        message: "OmniRoute could not use the selected model. Refresh the model menu and pick another one.",
        code: "omniroute_model_unavailable"
      };
    }
    return {
      status: 502,
      message: "OmniRoute or one of its upstream providers failed. Try again shortly or pick another model.",
      code: "omniroute_upstream_error"
    };
  }
  if (provider?.shared) {
    if (error.code === "rate_limited" || error.code === "insufficient_credits" || isQuotaExhaustedError(error)) {
      const accountWide = isQuotaExhaustedError(error);
      if (accountWide) {
        return {
          status: 429,
          message:
            "The shared free-model quota is temporarily exhausted for the whole account. Switching models will not help until it resets — try again later, or connect your own provider in API settings.",
          code: "shared_quota_exhausted"
        };
      }
      return {
        status: 429,
        message:
          "This shared model is rate-limited right now. Pick another shared model from the model menu, or try again in a minute.",
        code: "shared_model_rate_limited"
      };
    }
    if (error.code === "empty_response" || error.code === "output_limit") {
      return {
        status: 502,
        message: "The shared model returned no answer text. Pick another shared model or try a shorter prompt.",
        code: "shared_empty_response"
      };
    }
    return {
      status: 503,
      message: "The shared AI model is temporarily unavailable. Try again later, or connect your own provider in API settings.",
      code: "shared_unavailable"
    };
  }
  return { status: providerFailureStatus(error), message: error.message, code: error.code };
}

function logProviderFailure(provider, error) {
  console.error(
    "Chat provider failure:",
    provider?.gateway ? "gateway" : provider?.shared ? "shared" : "personal",
    error?.code || "provider_error",
    typeof error?.status === "number" ? `HTTP ${error.status}` : "-"
  );
}

function canTrySharedFallback(provider, error) {
  if (!provider?.shared || !provider.fallbackModel) return false;
  if (!["model_unavailable", "not_found", "rate_limited", "timeout", "network_error", "provider_unavailable", "empty_response", "empty_stream"].includes(error?.code)) {
    return false;
  }
  if (isQuotaExhaustedError(error)) return false;
  return true;
}

function vupsRetryOptions() {
  const number = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  };
  return {
    maxRetries: Math.min(number("VUPS_MAX_RETRIES", 2), 5),
    baseDelayMs: number("VUPS_RETRY_BASE_MS", 500),
    maxDelayMs: number("VUPS_RETRY_MAX_MS", 8000),
    maxRetryAfterMs: number("VUPS_RETRY_MAX_RETRY_AFTER_MS", 15000)
  };
}

function providerHostFromUrl(value) {
  try {
    return new URL(String(value)).hostname || "unresolved";
  } catch {
    return "unresolved";
  }
}

function logVupsRetry({ attempt, delay, error, requestId, model, providerHost }) {
  const diagnostic = error?.diagnostics || {};
  console.warn(JSON.stringify({
    event: "vups_provider_retry",
    timestamp: new Date().toISOString(),
    requestId: requestId || null,
    providerHost: providerHost || diagnostic.providerHost || "unresolved",
    model: model || diagnostic.model || null,
    retry: attempt,
    nextAttempt: attempt + 1,
    delayMs: delay,
    httpStatus: typeof error?.status === "number" ? error.status : null,
    providerCode: diagnostic.providerCode || null,
    providerType: diagnostic.providerType || null,
    providerStatus: diagnostic.providerStatus || null,
    providerErrorCode: diagnostic.providerErrorCode || null,
    providerDetail: diagnostic.providerDetail || null,
    remedyHint: diagnostic.remedyHint || null,
    category: error?.category || diagnostic.category || "unknown",
    classification: error?.classification || diagnostic.classification || "unknown",
    retryable: error?.retryable ?? diagnostic.retryable ?? null,
    retryAfter: Number.isFinite(error?.retryAfter) ? error.retryAfter : null
  }));
}

function logVupsOutcome({
  outcome,
  requestId,
  model,
  providerHost,
  attempts,
  totalDurationMs,
  error = null,
  finalCode = null
}) {
  const diagnostic = error?.diagnostics || {};
  console.warn(JSON.stringify({
    event: "vups_provider_outcome",
    timestamp: new Date().toISOString(),
    outcome,
    requestId: requestId || null,
    providerHost: providerHost || diagnostic.providerHost || "unresolved",
    model: model || diagnostic.model || null,
    attempts: Number.isInteger(attempts) ? attempts : null,
    totalDurationMs: Number.isFinite(totalDurationMs) ? totalDurationMs : null,
    httpStatus: typeof error?.status === "number" ? error.status : null,
    providerCode: diagnostic.providerCode || null,
    providerType: diagnostic.providerType || null,
    providerStatus: diagnostic.providerStatus || null,
    providerErrorCode: diagnostic.providerErrorCode || null,
    providerDetail: diagnostic.providerDetail || null,
    remedyHint: diagnostic.remedyHint || null,
    category: error?.category || diagnostic.category || null,
    classification: error?.classification || diagnostic.classification || null,
    retryable: error?.retryable ?? diagnostic.retryable ?? null,
    retryAfter: Number.isFinite(error?.retryAfter) ? error.retryAfter : null,
    finalCode
  }));
}

function vupsFailure(error, { hasImages = false } = {}) {
  const code = error?.code || "vups_upstream_error";
  if (code === "vups_not_configured") return { status: 503, message: error.message, code };
  if (code === "free_quota_exhausted" || code === "quota_exhausted" || isQuotaExhaustedError(error)) {
    return {
      status: 429,
      message: "Vups v3 Galax's upstream quota is exhausted or its credits are depleted. Wait for the provider's reset, or configure a funded model.",
      code: "vups_quota_exhausted"
    };
  }
  if (error?.category === "concurrency_limit") {
    return {
      status: 429,
      message: "Vups v3 Galax's upstream provider has reached its concurrency limit. Please wait a moment and try again.",
      code: "vups_concurrency_limited"
    };
  }
  if (error?.category === "rate_limit_tokens") {
    return {
      status: 429,
      message: "Vups v3 Galax's upstream provider has reached its token-per-minute limit. Please wait a moment and try again.",
      code: "vups_token_rate_limited"
    };
  }
  if (code === "rate_limited") {
    return {
      status: 429,
      message: "Vups v3 Galax is rate-limited by its upstream provider right now. Please wait a moment and try again.",
      code: "vups_rate_limited"
    };
  }
  if (code === "timeout") {
    return {
      status: 504,
      message: "Vups v3 Galax took too long to answer. Please try again.",
      code: "vups_timeout"
    };
  }
  if (code === "output_limit") {
    return {
      status: 502,
      message: "Vups v3 Galax reached its output limit before writing an answer. Try a shorter prompt.",
      code: "vups_output_limit"
    };
  }
  const detail = typeof error?.message === "string" ? error.message : "";
  const visionUnsupported = hasImages && /no endpoints found that support image input|does not support image input|image input (?:is )?not supported|does not accept image/i.test(detail);
  if (hasImages && (visionUnsupported || ["bad_request", "unprocessable"].includes(code))) {
    return {
      status: 400,
      message: "Vups v3 Galax could not read that image. The configured underlying model may not support image input. Try a different image or continue with text.",
      code: "vups_vision_rejected"
    };
  }
  if (["invalid_api_key", "forbidden", "insufficient_credits"].includes(code)) {
    return {
      status: 503,
      message: "Vups v3 Galax is not available right now. Ask the administrator to verify the server configuration.",
      code: "vups_unavailable"
    };
  }
  if (["invalid_model", "not_found", "model_unavailable", "empty_response", "empty_stream"].includes(code)) {
    return {
      status: 503,
      message: hasImages
        ? "Vups v3 Galax's configured vision model is unavailable right now. Ask the administrator to verify VUPS_VISION_MODEL."
        : "Vups v3 Galax's configured underlying model is unavailable right now. Ask the administrator to verify VUPS_UNDERLYING_MODEL.",
      code: "vups_model_unavailable"
    };
  }
  if (code === "provider_unavailable") {
    const upstreamStatus = typeof error?.status === "number" && error.status >= 500 && error.status <= 599
      ? error.status
      : 503;
    return {
      status: upstreamStatus,
      message: upstreamStatus === 503
        ? "Vups v3 Galax's upstream provider is temporarily overloaded. Please try again shortly."
        : "Vups v3 Galax's upstream provider failed temporarily. Please try again shortly.",
      code: "vups_upstream_unavailable"
    };
  }
  if (["network_error", "dns_error", "connection_refused"].includes(code)) {
    return {
      status: 502,
      message: "Vups v3 Galax could not reach its configured server. Please try again later.",
      code: "vups_unreachable"
    };
  }
  if (code === "too_large" || code === "response_too_large") {
    return {
      status: 413,
      message: "That request is too large for Vups v3 Galax. Shorten the conversation or image and try again.",
      code
    };
  }
  return {
    status: 502,
    message: "Vups v3 Galax could not complete that request. Please try again.",
    code: "vups_upstream_error"
  };
}

router.post("/vups-v3-galax", requireAuth, vupsGalaxRateLimiter, async (req, res, next) => {
  const requestId = req.requestId || null;
  try {
    const body = req.body || {};
    const validated = validateMessages(body.messages);
    if (typeof validated === "string") return res.status(400).json({ message: validated });

    if (body.model !== undefined && body.model !== VUPS_MODEL_ID) {
      return res.status(400).json({ message: "This route only serves Vups v3 Galax.", code: "invalid_model" });
    }
    if (body.system !== undefined || body.systemPrompt !== undefined) {
      return res.status(400).json({ message: "System prompts are configured by the server and cannot be supplied by the client.", code: "invalid_prompt_source" });
    }

    let mode;
    try {
      mode = normalizeVupsMode(body.mode);
    } catch (error) {
      if (error instanceof ProviderError) return res.status(error.status ?? 400).json({ message: error.message, code: error.code });
      throw error;
    }

    const stream = body.stream !== false;
    const temperature =
      typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 2
        ? body.temperature
        : undefined;
    const hasImages = validated.messages.some(message => Array.isArray(message.images) && message.images.length > 0);

    let provider;
    try {
      provider = vupsProviderForChat({ images: hasImages });
    } catch (error) {
      if (error instanceof ProviderError) {
        return res.status(error.status ?? 503).json({ message: error.message, code: error.code });
      }
      throw error;
    }
    if (hasImages && provider.vision === false) {
      return res.status(400).json({
        message: "Vups v3 Galax's configured underlying model does not support image input. Continue with text or ask the administrator to configure a vision-capable model.",
        code: "vups_vision_unsupported"
      });
    }
    const providerHost = providerHostFromUrl(provider.baseUrl);

    await connectToDatabase();
    if (req.user?.aiEnabled === false) {
      return res.status(403).json({ message: "AI chat has been disabled for your account by an administrator.", code: "ai_disabled" });
    }

    if (!acquireSlot(req.userId)) {
      return res.status(429).json({
        message: "Too many AI requests are already in flight for your account. Wait for them to finish and try again.",
        code: "concurrency_limit"
      });
    }
    res.on("close", () => releaseSlot(req.userId));
    try {
      await consumeDailyQuota(req.userId);
    } catch (error) {
      if (error instanceof UsageError) return res.status(429).json({ message: error.message, code: error.code });
      throw error;
    }

    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    const upstreamMessages = [{ role: "system", content: buildVupsSystemPrompt(mode) }, ...validated.messages];

    if (!stream) {
      let result;
      let attempts = 0;
      const startedAt = Date.now();
      const retryOptions = {
        ...vupsRetryOptions(),
        onRetry: event => logVupsRetry({
          ...event,
          requestId,
          model: provider.model,
          providerHost
        })
      };
      try {
        result = await withProviderRetry(
          (attempt) => {
            attempts = attempt + 1;
            return chatCompletion({
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              providerType: provider.providerType,
              model: provider.model,
              messages: upstreamMessages,
              temperature,
              reasoning: provider.reasoning,
              requestId,
              attempt: attempt + 1
            });
          },
          retryOptions
        );
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        const failure = vupsFailure(error, { hasImages });
        logVupsOutcome({
          outcome: "failed",
          requestId,
          model: provider.model,
          providerHost,
          attempts: attempts || 1,
          totalDurationMs: Date.now() - startedAt,
          error,
          finalCode: failure.code
        });
        return sendProviderFailure(res, failure, error, requestId);
      }
      if (attempts > 1) {
        logVupsOutcome({
          outcome: "recovered",
          requestId,
          model: provider.model,
          providerHost,
          attempts,
          totalDurationMs: Date.now() - startedAt
        });
      }
      const conversation = await persistConversation(req.userId, conversationId, validated.messages, result.content);
      return res.json({
        conversationId: String(conversation._id),
        model: VUPS_MODEL_ID,
        message: { role: "assistant", content: result.content },
        finishReason: result.finishReason
      });
    }

    let existingConversation = null;
    if (conversationId && mongoose.isValidObjectId(conversationId)) {
      existingConversation = await Conversation.findOne({ _id: conversationId, userId: req.userId }).select("_id");
    }
    const prospectiveId = existingConversation ? String(existingConversation._id) : String(new mongoose.Types.ObjectId());

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstream;
    let streamAttempts = 0;
    const streamStartedAt = Date.now();
    const streamRetryOptions = {
      ...vupsRetryOptions(),
      signal: controller.signal,
      onRetry: event => logVupsRetry({
        ...event,
        requestId,
        model: provider.model,
        providerHost
      })
    };
    try {
      upstream = await withProviderRetry(
        (attempt) => {
          streamAttempts = attempt + 1;
          return startChatCompletionStream(
            {
              baseUrl: provider.baseUrl,
              apiKey: provider.apiKey,
              providerType: provider.providerType,
              model: provider.model,
              messages: upstreamMessages,
              temperature,
              reasoning: provider.reasoning,
              requestId,
              attempt: attempt + 1
            },
            controller.signal
          );
        },
        streamRetryOptions
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProviderError) {
        const failure = vupsFailure(error, { hasImages });
        logVupsOutcome({
          outcome: "failed",
          requestId,
          model: provider.model,
          providerHost,
          attempts: streamAttempts || 1,
          totalDurationMs: Date.now() - streamStartedAt,
          error,
          finalCode: failure.code
        });
        return sendProviderFailure(res, failure, error, requestId);
      }
      return next(error);
    }
    if (streamAttempts > 1) {
      logVupsOutcome({
        outcome: "recovered",
        requestId,
        model: provider.model,
        providerHost,
        attempts: streamAttempts,
        totalDurationMs: Date.now() - streamStartedAt
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    sendEvent(res, { type: "meta", conversationId: prospectiveId, model: VUPS_MODEL_ID });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let failure = null;
    let finishReason = null;
    let usage = null;

    try {
      while (!failure) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          if (parsed?.error) {
            failure = new ProviderError("The provider reported an error during streaming.", null, "stream_error");
            break;
          }
          if (parsed?.type === "response.failed") {
            failure = new ProviderError("The provider reported an error during streaming.", null, "stream_error");
            break;
          }
          const choice = parsed?.choices?.[0];
          if (choice?.error) {
            failure = new ProviderError("The provider reported an error during streaming.", null, "stream_error");
            break;
          }
          if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          if (parsed?.usage && typeof parsed.usage === "object") {
            usage = parsed.usage;
          }
          if (parsed?.type === "message_start" && parsed.message?.usage) {
            usage = parsed.message.usage;
          }
          if (parsed?.type === "message_delta") {
            if (parsed.usage && typeof parsed.usage === "object") usage = { ...(usage || {}), ...parsed.usage };
            const stopReason = parsed.delta?.stop_reason;
            if (stopReason === "max_tokens") finishReason = "length";
            else if (stopReason === "end_turn" || stopReason === "stop_sequence") finishReason = "stop";
            else if (typeof stopReason === "string") finishReason = stopReason;
          }
          if ((parsed?.type === "response.completed" || parsed?.type === "response.incomplete") && parsed.response) {
            if (parsed.response.usage && typeof parsed.response.usage === "object") usage = parsed.response.usage;
            const incomplete = parsed.response.incomplete_details?.reason;
            if (typeof incomplete === "string" && incomplete) {
              finishReason = incomplete === "max_output_tokens" ? "length" : incomplete;
            } else if (parsed.response.status === "completed") {
              finishReason = finishReason ?? "stop";
            }
          }
          const text = extractStreamText(parsed);
          if (text) {
            fullText += text;
            if (fullText.length > MAX_UPSTREAM_TEXT_CHARS) {
              failure = new ProviderError("The provider returned more text than VupsRouter can safely process.", null, "response_too_large");
              break;
            }
            sendEvent(res, { type: "delta", content: text });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failure = error instanceof ProviderError ? error : new ProviderError("The provider stream was interrupted.", null, "stream_error");
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    }

    if (!failure && fullText.length === 0 && !controller.signal.aborted) {
      failure = finishReason === "length"
        ? new ProviderError("Vups v3 Galax reached its output limit before writing an answer. Try a shorter prompt.", null, "output_limit")
        : new ProviderError("The provider returned an empty response.", null, "empty_response");
    }

    if (fullText.length > 0) {
      try {
        const conversation = await persistConversation(req.userId, prospectiveId, validated.messages, fullText);
        if (!failure && !controller.signal.aborted) {
          sendEvent(res, {
            type: "done",
            conversationId: String(conversation._id),
            finishReason: finishReason ?? "stop",
            model: VUPS_MODEL_ID,
            ...(usage ? { usage } : {})
          });
        }
      } catch {
        if (!failure) failure = new ProviderError("The response was generated but could not be saved to your history.", null, "persist_failed");
      }
    }

    if (failure) {
      const safe = vupsFailure(failure, { hasImages });
      if (!controller.signal.aborted) {
        logVupsOutcome({
          outcome: "failed",
          requestId,
          model: provider.model,
          providerHost,
          attempts: streamAttempts || 1,
          totalDurationMs: Date.now() - streamStartedAt,
          error: failure,
          finalCode: safe.code
        });
        sendEvent(res, {
          type: "error",
          message: safe.message,
          code: safe.code,
          ...(requestId ? { requestId } : {})
        });
      }
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (res.headersSent) {
      sendEvent(res, {
        type: "error",
        message: "Something went wrong while streaming the Vups v3 Galax response.",
        code: "vups_stream_error",
        ...(requestId ? { requestId } : {})
      });
      if (!res.writableEnded) res.end();
      return;
    }
    return next(error);
  }
});

router.post("/", requireAuth, chatRateLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const validated = validateMessages(body.messages);
    if (typeof validated === "string") return res.status(400).json({ message: validated });

    const stream = body.stream !== false;
    const mode = typeof body.mode === "string" ? body.mode.trim().toLowerCase() || "general" : "general";
    if (!CHAT_MODES.has(mode)) {
      return res.status(400).json({ message: "Unknown chat mode. Choose general or motion.", code: "invalid_mode" });
    }
    const temperature =
      typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 2
        ? body.temperature
        : undefined;

    await connectToDatabase();

    if (req.user?.aiEnabled === false) {
      return res.status(403).json({ message: "AI chat has been disabled for your account by an administrator.", code: "ai_disabled" });
    }

    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    const requestedConfigId = typeof body.configId === "string" ? body.configId.trim() : "";
    const requestedProviderId = typeof body.providerId === "string" ? body.providerId.trim().slice(0, 80) : "";
    const requestedSource = typeof body.source === "string" ? body.source.trim().toLowerCase() : "";

    let provider;
    try {
      provider = await resolveProvider(req.userId, requestedModel, requestedConfigId, requestedSource, requestedProviderId);
    } catch (error) {
      if (error instanceof ProviderError) {
        return res.status(error.status ?? (error.code === "key_decryption_failed" ? 500 : 400)).json({ message: error.message, code: error.code });
      }
      throw error;
    }

    const model = requestedModel || provider.defaultModel;
    if (!model) return res.status(400).json({ message: "Select a model in Settings or choose one from the model picker.", code: "no_model" });

    const lastMessage = validated.messages[validated.messages.length - 1];
    if (lastMessage.images?.length > 0 && provider.shared && !provider.visionModelIds.includes(model)) {
      const alternatives = provider.visionModelIds;
      const suggestion = alternatives.length > 0
        ? `Vision-capable shared models you can use instead: ${alternatives.join(", ")}.`
        : "Connect your own vision-capable provider in API settings.";
      return res.status(400).json({
        message: `The selected model (${model}) does not accept image inputs. ${suggestion}`,
        code: "model_no_vision"
      });
    }

    if (!acquireSlot(req.userId)) {
      return res.status(429).json({
        message: "Too many AI requests are already in flight for your account. Wait for them to finish and try again.",
        code: "concurrency_limit"
      });
    }
    res.on("close", () => releaseSlot(req.userId));
    try {
      await consumeDailyQuota(req.userId);
    } catch (error) {
      if (error instanceof UsageError) return res.status(429).json({ message: error.message, code: error.code });
      throw error;
    }

    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    const upstreamMessages = [{ role: "system", content: CHAT_MODES.get(mode) }, ...validated.messages];

    if (!stream) {
      let result;
      let usedModel = model;
      let fallbackUsed = false;
      while (true) {
        try {
          result = await chatCompletion(
            { baseUrl: provider.baseUrl, apiKey: provider.apiKey, providerType: provider.providerType, model: usedModel, messages: upstreamMessages, temperature, maxTokens: provider.maxTokens, reasoning: provider.reasoning },
            undefined
          );
          break;
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          logProviderFailure(provider, error);
          if (!fallbackUsed && canTrySharedFallback(provider, error)) {
            fallbackUsed = true;
            usedModel = provider.fallbackModel;
            continue;
          }
          const failure = providerFailure(provider, error);
          return sendProviderFailure(res, failure, error);
        }
      }
      const conversation = await persistConversation(req.userId, conversationId, validated.messages, result.content);
      return res.json({
        conversationId: String(conversation._id),
        message: { role: "assistant", content: result.content },
        finishReason: result.finishReason,
        ...(fallbackUsed ? { model: usedModel, fallbackUsed: true } : {})
      });
    }

    let existingConversation = null;
    if (conversationId && mongoose.isValidObjectId(conversationId)) {
      existingConversation = await Conversation.findOne({ _id: conversationId, userId: req.userId }).select("_id");
    }
    const prospectiveId = existingConversation ? String(existingConversation._id) : String(new mongoose.Types.ObjectId());

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstream;
    let usedModel = model;
    let fallbackUsed = false;
    while (true) {
      try {
        upstream = await startChatCompletionStream(
          { baseUrl: provider.baseUrl, apiKey: provider.apiKey, providerType: provider.providerType, model: usedModel, messages: upstreamMessages, temperature, maxTokens: provider.maxTokens, reasoning: provider.reasoning },
          controller.signal
        );
        break;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ProviderError) {
          logProviderFailure(provider, error);
          if (!fallbackUsed && canTrySharedFallback(provider, error)) {
            fallbackUsed = true;
            usedModel = provider.fallbackModel;
            continue;
          }
          const failure = providerFailure(provider, error);
          return sendProviderFailure(res, failure, error);
        }
        return next(error);
      }
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    sendEvent(res, {
      type: "meta",
      conversationId: prospectiveId,
      ...(fallbackUsed ? { model: usedModel, fallbackUsed: true } : {})
    });

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let failure = null;
    let finishReason = null;
    let usage = null;

    try {
      while (!failure) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const raw = trimmed.slice(5).trim();
          if (!raw || raw === "[DONE]") continue;
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          if (parsed?.error) {
            failure = new ProviderError(
              typeof parsed.error?.message === "string"
                ? `The provider reported an error during streaming: ${redactSecrets(parsed.error.message)}`
                : "The provider reported an error during streaming.",
              null,
              "stream_error"
            );
            break;
          }
          if (parsed?.type === "response.failed") {
            const detail = parsed.response?.error?.message;
            failure = new ProviderError(
              typeof detail === "string"
                ? `The provider reported an error during streaming: ${redactSecrets(detail)}`
                : "The provider reported an error during streaming.",
              null,
              "stream_error"
            );
            break;
          }
          const choice = parsed?.choices?.[0];
          if (choice?.error) {
            const detail = typeof choice.error?.message === "string" ? choice.error.message : "";
            failure = new ProviderError(
              detail
                ? `The provider reported an error during streaming: ${redactSecrets(detail)}`
                : "The provider reported an error during streaming.",
              null,
              "stream_error"
            );
            break;
          }
          if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
            finishReason = choice.finish_reason;
          }
          if (parsed?.usage && typeof parsed.usage === "object") {
            usage = parsed.usage;
          }
          if (parsed?.type === "message_start" && parsed.message?.usage) {
            usage = parsed.message.usage;
          }
          if (parsed?.type === "message_delta") {
            if (parsed.usage && typeof parsed.usage === "object") usage = { ...(usage || {}), ...parsed.usage };
            const stopReason = parsed.delta?.stop_reason;
            if (stopReason === "max_tokens") finishReason = "length";
            else if (stopReason === "end_turn" || stopReason === "stop_sequence") finishReason = "stop";
            else if (typeof stopReason === "string") finishReason = stopReason;
          }
          if ((parsed?.type === "response.completed" || parsed?.type === "response.incomplete") && parsed.response) {
            if (parsed.response.usage && typeof parsed.response.usage === "object") usage = parsed.response.usage;
            const incomplete = parsed.response.incomplete_details?.reason;
            if (typeof incomplete === "string" && incomplete) {
              finishReason = incomplete === "max_output_tokens" ? "length" : incomplete;
            } else if (parsed.response.status === "completed") {
              finishReason = finishReason ?? "stop";
            }
          }
          const text = extractStreamText(parsed);
          if (text) {
            fullText += text;
            if (fullText.length > MAX_UPSTREAM_TEXT_CHARS) {
              failure = new ProviderError("The provider returned more text than VupsRouter can safely process.", null, "response_too_large");
              break;
            }
            sendEvent(res, { type: "delta", content: text });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failure = error instanceof ProviderError ? error : new ProviderError("The provider stream was interrupted.", null, "stream_error");
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    }

    if (!failure && fullText.length === 0 && !controller.signal.aborted) {
      failure = finishReason === "length"
        ? new ProviderError("The model reached its output limit before writing an answer. Try a shorter prompt or choose another model.", null, "output_limit")
        : new ProviderError("The provider returned an empty response. Check the model ID and try again.", null, "empty_response");
    }

    if (fullText.length > 0) {
      try {
        const conversation = await persistConversation(req.userId, prospectiveId, validated.messages, fullText);
        if (!failure && !controller.signal.aborted) {
          sendEvent(res, {
            type: "done",
            conversationId: String(conversation._id),
            finishReason: finishReason ?? "stop",
            ...(usage ? { usage } : {})
          });
        }
      } catch (error) {
        if (!failure) failure = new ProviderError("The response was generated but could not be saved to your history.", null, "persist_failed");
      }
    }

    if (failure) {
      logProviderFailure(provider, failure);
      if (!controller.signal.aborted) sendEvent(res, { type: "error", message: failure.message, code: failure.code });
    }
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (res.headersSent) {
      sendEvent(res, { type: "error", message: "Something went wrong while streaming the response." });
      if (!res.writableEnded) res.end();
      return;
    }
    return next(error);
  }
});

export default router;
