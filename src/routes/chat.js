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
  normalizeBaseUrl,
  redactSecrets,
  startChatCompletionStream
} from "../providerClient.js";
import { chatRateLimiter, requireAuth } from "../middleware.js";
import { UsageError, acquireSlot, consumeDailyQuota, releaseSlot } from "../usage.js";
import { sharedModelStatus, sharedProviderForChat } from "../sharedModel.js";
import { resolveOmniRouteChat } from "../omniroute.js";
import { attachmentMetadata, validateImages } from "../chatImages.js";

const router = Router();

const SYSTEM_PROMPT =
  "You are the VupsRouter AI assistant. VupsRouter helps developers and users explore AI models — hosted providers, OpenAI-compatible APIs, and locally-run open-weight models. Be concise, helpful, and honest about model limitations. Use markdown when it improves clarity. Do not pretend to know real-time facts you do not have. For large projects or multi-file code (for example a full marketplace app), organize the answer into named files/modules and generate them in manageable stages instead of promising an entire complex project in one reply. When the output limit is near, stop at a natural boundary and tell the user which files remain so they can continue.";

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
  const configuredFallback =
    shared.fallbackModel && shared.fallbackModel !== model && readyIds.includes(shared.fallbackModel)
      ? shared.fallbackModel
      : null;
  const fallbackModel = configuredFallback || readyIds.find(id => id !== model) || null;
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
    visionModelIds
  };
}

async function resolveProvider(userId, requestedModel, requestedConfigId, requestedSource = "") {
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
  }

  const sharedIds = new Set(sharedModelsOf(shared).map(model => model.id));
  if (!requestedConfigId) {
    if (requestedModel && sharedIds.has(requestedModel)) {
      return sharedRoute(shared, requestedModel);
    }
    config =
      (await ProviderConfig.findOne({ userId, active: true }).select("+encryptedApiKey")) ||
      (await ProviderConfig.findOne({ userId }).sort({ updatedAt: -1 }).select("+encryptedApiKey"));
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
    if (error.code === "rate_limited" || error.code === "insufficient_credits") {
      const accountWide =
        error.code === "insufficient_credits" ||
        /free-models-per-day|per.day|daily|credits|balance/i.test(String(error.message || ""));
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
  if (error.code === "rate_limited" && /free-models-per-day|per.day|daily|credits|balance/i.test(String(error.message || ""))) {
    return false;
  }
  return true;
}

router.post("/", requireAuth, chatRateLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const validated = validateMessages(body.messages);
    if (typeof validated === "string") return res.status(400).json({ message: validated });

    const stream = body.stream !== false;
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
    const requestedSource = typeof body.source === "string" ? body.source.trim().toLowerCase() : "";

    let provider;
    try {
      provider = await resolveProvider(req.userId, requestedModel, requestedConfigId, requestedSource);
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
    const upstreamMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...validated.messages];

    if (!stream) {
      let result;
      let usedModel = model;
      let fallbackUsed = false;
      while (true) {
        try {
          result = await chatCompletion(
            { baseUrl: provider.baseUrl, apiKey: provider.apiKey, providerType: provider.providerType, model: usedModel, messages: upstreamMessages, temperature, maxTokens: provider.maxTokens },
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
          return res.status(failure.status).json({ message: failure.message, code: failure.code });
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
          { baseUrl: provider.baseUrl, apiKey: provider.apiKey, providerType: provider.providerType, model: usedModel, messages: upstreamMessages, temperature, maxTokens: provider.maxTokens },
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
          return res.status(failure.status).json({ message: failure.message, code: failure.code });
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
      failure = new ProviderError("The provider returned an empty response. Check the model ID and try again.", null, "empty_response");
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
