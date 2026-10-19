import { Router } from "express";
import mongoose from "mongoose";
import connectToDatabase, { isDatabaseFailure } from "../db.js";
import ProviderConfig from "../providerConfig.js";
import Conversation from "../conversation.js";
import { decryptSecret } from "../encryption.js";
import {
  ProviderError,
  chatCompletion,
  extractStreamText,
  normalizeBaseUrl,
  startChatCompletionStream
} from "../providerClient.js";
import { chatRateLimiter, requireAuth } from "../middleware.js";
import { UsageError, acquireSlot, consumeDailyQuota, releaseSlot } from "../usage.js";
import { sharedModelStatus, sharedProviderForChat } from "../sharedModel.js";

const router = Router();

const SYSTEM_PROMPT =
  "You are the VupsRouter AI assistant. VupsRouter helps developers and users explore AI models — hosted providers, OpenAI-compatible APIs, and locally-run open-weight models. Be concise, helpful, and honest about model limitations. Use markdown when it improves clarity. Do not pretend to know real-time facts you do not have. For large projects or multi-file code (for example a full marketplace app), organize the answer into named files/modules and generate them in manageable stages instead of promising an entire complex project in one reply. When the output limit is near, stop at a natural boundary and tell the user which files remain so they can continue.";

const MAX_MESSAGES = 60;
const MAX_TOTAL_CHARS = 120000;
const MAX_STORED_MESSAGES = 200;

function validateMessages(value) {
  if (!Array.isArray(value) || value.length === 0) return "messages must be a non-empty array.";
  if (value.length > MAX_MESSAGES) return `A request can contain at most ${MAX_MESSAGES} messages.`;
  const messages = [];
  let total = 0;
  for (const entry of value) {
    const role = entry?.role;
    const content = typeof entry?.content === "string" ? entry.content : "";
    if (role !== "user" && role !== "assistant") return "Every message needs a role of user or assistant.";
    if (content.trim().length === 0) return "Message content cannot be empty.";
    if (content.length > 32000) return "A single message cannot exceed 32000 characters.";
    total += content.length;
    if (total > MAX_TOTAL_CHARS) return "The conversation is too large. Start a new chat or shorten your messages.";
    messages.push({ role, content });
  }
  if (messages[messages.length - 1].role !== "user") return "The last message must come from the user.";
  return { messages };
}

const SHARED_UNAVAILABLE_MESSAGES = {
  not_configured: "The shared AI model is not configured on this server. Configure your own provider in API settings.",
  unreachable: "The shared AI model server is unreachable right now. Please try again later or use your own provider.",
  missing_model: "The shared model is not installed on the shared server. Please try again later or use your own provider."
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
  let model;
  if (requestedModel) {
    if (readyIds.includes(requestedModel)) {
      model = requestedModel;
    } else if (enabledModels.some(entry => entry.id === requestedModel)) {
      throw new ProviderError(
        `That shared model is not available right now. Pick another shared model (${readyIds.join(", ")}) or try again later.`,
        503,
        "shared_model_unavailable"
      );
    } else {
      throw new ProviderError(
        `"${requestedModel.slice(0, 80)}" is not an enabled shared model. Choose one of: ${readyIds.join(", ")}.`,
        400,
        "invalid_model"
      );
    }
  } else {
    model = readyIds[0];
  }
  return {
    shared: true,
    provider: provider.provider,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    defaultModel: model,
    maxTokens: provider.maxTokens
  };
}

async function resolveProvider(userId, requestedModel) {
  const shared = await sharedModelStatusSafely();
  const config = await ProviderConfig.findOne({ userId }).select("+encryptedApiKey");
  const sharedIds = new Set(sharedModelsOf(shared).map(model => model.id));
  if (requestedModel && sharedIds.has(requestedModel)) {
    return sharedRoute(shared, requestedModel);
  }
  if (!config) {
    return sharedRoute(shared, requestedModel);
  }
  let apiKey;
  try {
    apiKey = decryptSecret(config.encryptedApiKey);
  } catch {
    throw new ProviderError("The stored API key could not be decrypted. Re-enter and save your key in Settings.", 500, "key_decryption_failed");
  }
  return {
    shared: false,
    provider: config.provider,
    baseUrl: normalizeBaseUrl(config.baseUrl),
    defaultModel: config.model || "",
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

async function persistConversation(userId, conversationId, messages, assistantText) {
  const storedMessages = [...messages, { role: "assistant", content: assistantText }].slice(-MAX_STORED_MESSAGES);
  const firstUser = storedMessages.find(message => message.role === "user");
  const title = (firstUser?.content ?? "New chat").replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
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
  invalid_api_key: 401,
  insufficient_credits: 402,
  forbidden: 403,
  too_large: 413,
  unprocessable: 422,
  rate_limited: 429,
  timeout: 504,
  provider_unavailable: 502,
  network_error: 502,
  empty_response: 502,
  stream_error: 502
};

function providerFailureStatus(error) {
  if (error?.code && PROVIDER_STATUS_BY_CODE[error.code]) return PROVIDER_STATUS_BY_CODE[error.code];
  if (typeof error?.status === "number" && error.status >= 400 && error.status <= 499) return 400;
  return 502;
}

function providerFailure(provider, error) {
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
    provider?.shared ? "shared" : "personal",
    error?.code || "provider_error",
    typeof error?.status === "number" ? `HTTP ${error.status}` : "-"
  );
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

    let provider;
    try {
      provider = await resolveProvider(req.userId, requestedModel);
    } catch (error) {
      if (error instanceof ProviderError) {
        return res.status(error.status ?? (error.code === "key_decryption_failed" ? 500 : 400)).json({ message: error.message, code: error.code });
      }
      throw error;
    }

    const model = requestedModel || provider.defaultModel;
    if (!model) return res.status(400).json({ message: "Select a model in Settings or choose one from the model picker.", code: "no_model" });

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
      try {
        result = await chatCompletion(
          { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, messages: upstreamMessages, temperature, maxTokens: provider.maxTokens },
          undefined
        );
      } catch (error) {
        if (error instanceof ProviderError) {
          logProviderFailure(provider, error);
          const failure = providerFailure(provider, error);
          return res.status(failure.status).json({ message: failure.message, code: failure.code });
        }
        throw error;
      }
      const conversation = await persistConversation(req.userId, conversationId, validated.messages, result.content);
      return res.json({
        conversationId: String(conversation._id),
        message: { role: "assistant", content: result.content },
        finishReason: result.finishReason
      });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    let existingConversation = null;
    if (conversationId && mongoose.isValidObjectId(conversationId)) {
      existingConversation = await Conversation.findOne({ _id: conversationId, userId: req.userId }).select("_id");
    }
    const prospectiveId = existingConversation ? String(existingConversation._id) : String(new mongoose.Types.ObjectId());
    sendEvent(res, { type: "meta", conversationId: prospectiveId });

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    let upstream;
    try {
      upstream = await startChatCompletionStream(
        { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, messages: upstreamMessages, temperature, maxTokens: provider.maxTokens },
        controller.signal
      );
    } catch (error) {
      const failure = error instanceof ProviderError ? providerFailure(provider, error) : null;
      if (error instanceof ProviderError) logProviderFailure(provider, error);
      const message = failure ? failure.message : "Could not reach the provider.";
      if (!controller.signal.aborted) sendEvent(res, { type: "error", message, ...(failure ? { code: failure.code } : {}) });
      if (!res.writableEnded) res.end();
      return;
    }

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
                ? `The provider reported an error during streaming: ${parsed.error.message}`
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
          const text = extractStreamText(parsed);
          if (text) {
            fullText += text;
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
