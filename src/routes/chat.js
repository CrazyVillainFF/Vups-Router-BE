import { Router } from "express";
import mongoose from "mongoose";
import connectToDatabase, { isDatabaseFailure } from "../db.js";
import ProviderConfig from "../providerConfig.js";
import Conversation from "../conversation.js";
import Artifact from "../artifact.js";
import {
  ArtifactError,
  applyContinuationFile,
  buildCodeArtifact,
  continuationPlan,
  mergeContinuation
} from "../codeArtifacts.js";
import { decryptSecret } from "../encryption.js";
import {
  ProviderError,
  CONTEXT_LIMIT_MESSAGE,
  assertAllowedProviderUrl,
  buildProviderFailureDiagnostic,
  chatCompletion,
  extractStreamReasoning,
  extractStreamText,
  isQuotaExhaustedError,
  normalizeBaseUrl,
  providerSupportsToolCalling,
  redactSecrets,
  startChatCompletionStream,
  withProviderRetry
} from "../providerClient.js";
import { chatRateLimiter, requireAuth, vupsGalaxRateLimiter } from "../middleware.js";
import { UsageError, acquireSlot, consumeDailyQuota, releaseSlot } from "../usage.js";
import { sharedModelStatus, sharedProviderForChat } from "../sharedModel.js";
import { resolveOmniRouteChat } from "../omniroute.js";
import { attachmentMetadata, validateImages } from "../chatImages.js";
import { resolveTerminalEvent, writeSseEvent } from "../chatTerminal.js";
import { runPluginToolLoop } from "../plugins/toolChat.js";
import {
  DESKTOP_TOOLS,
  DESKTOP_TOOL_PROMPT,
  isDesktopToolName,
  normalizeDesktopToolCalls
} from "../desktopTools.js";
import {
  VUPS_MODEL_ID,
  buildVupsSystemPrompt,
  normalizeVupsMode,
  vupsExecutionConfiguration,
  vupsProviderForChat
} from "../vupsGalax.js";

const router = Router();

const SYSTEM_PROMPT =
  "You are the VupsRouter AI assistant. VupsRouter helps developers and users explore AI models ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â hosted providers, OpenAI-compatible APIs, and locally-run open-weight models. Be concise, helpful, and honest about model limitations. Use markdown when it improves clarity. Do not pretend to know real-time facts you do not have. For large projects or multi-file code (for example a full marketplace app), organize the answer into named files/modules and generate them in manageable stages instead of promising an entire complex project in one reply. When the output limit is near, stop at a natural boundary and tell the user which files remain so they can continue. For downloadable multi-file projects, put a line in the exact form `FILE: relative/path.ext` immediately before each fenced code block so the client can package the real files; use safe relative paths and never invent files.";

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
const MAX_ASSISTANT_MESSAGE_CHARS = 100000;
const MAX_STORED_CHARS = 4_000_000;
const FILE_MARKER_RE = /\b(?:file|filename)\s*:\s*[`"'*]*([^\s`"'*]+)/gi;
const MAX_UPSTREAM_TEXT_CHARS = 2_000_000;

function validateMessages(value, { allowAssistantLast = false } = {}) {
  if (!Array.isArray(value) || value.length === 0) return "messages must be a non-empty array.";
  if (value.length > MAX_MESSAGES) return `A request can contain at most ${MAX_MESSAGES} messages.`;
  const messages = [];
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const role = entry?.role;
    const content = typeof entry?.content === "string" ? entry.content : "";
    const messageId = typeof entry?.messageId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(entry.messageId.trim())
      ? entry.messageId.trim()
      : undefined;
    if (role !== "user" && role !== "assistant") return "Every message needs a role of user or assistant.";
    if (role === "user" && content.length > 32000) return "A single message cannot exceed 32000 characters.";
    if (role === "assistant" && content.length > MAX_ASSISTANT_MESSAGE_CHARS) return "A single assistant message is too large to replay. Start a new chat or continue from the saved code artifact.";
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
      messages.push({ role, content, images: images.images, attachmentMeta: attachmentMetadata(images.images), ...(messageId ? { messageId } : {}) });
    } else {
      messages.push({ role, content, ...(messageId ? { messageId } : {}) });
    }
  }
  if (!allowAssistantLast && messages[messages.length - 1].role !== "user") return "The last message must come from the user.";
  return { messages };
}

const MAX_DESKTOP_STEPS = 6;
const DESKTOP_RUN_TTL_MS = 10 * 60 * 1000;
const desktopRuns = new Map();

function validDesktopRunId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value.trim());
}

function validateDesktopMessages(value) {
  if (!Array.isArray(value) || value.length === 0) return "messages must be a non-empty array.";
  if (value.length > MAX_MESSAGES + 12) return "A desktop tool request can contain at most 72 messages.";
  const messages = [];
  let total = 0;
  for (const entry of value) {
    const role = entry?.role;
    const content = typeof entry?.content === "string" ? entry.content : "";
    if (role !== "user" && role !== "assistant" && role !== "tool") {
      return "Every desktop tool message needs a role of user, assistant, or tool.";
    }
    if (role === "tool") {
      const callId = typeof entry?.tool_call_id === "string" ? entry.tool_call_id.trim() : "";
      if (!callId || callId.length > 120) return "Every tool result needs its tool call id.";
      if (!content.trim()) return "A tool result cannot be empty.";
      if (content.length > 20000) return "A tool result is too large to send back to the model.";
      total += content.length;
      messages.push({ role, tool_call_id: callId, content });
    } else if (role === "assistant") {
      const toolCalls = Array.isArray(entry?.tool_calls) ? entry.tool_calls : [];
      if (toolCalls.length > 5) return "The assistant can request at most five local tools per step.";
      if (content.length > MAX_ASSISTANT_MESSAGE_CHARS) return "A single assistant message is too large.";
      const normalizedCalls = toolCalls.map((call, index) => {
        const name = typeof call?.function?.name === "string" ? call.function.name : "";
        if (!isDesktopToolName(name)) return null;
        const id = typeof call?.id === "string" && call.id.trim()
          ? call.id.trim().slice(0, 120)
          : `desktop_call_${index}`;
        const args = typeof call?.function?.arguments === "string" ? call.function.arguments : "{}";
        if (args.length > 12000) return null;
        return { id, type: "function", function: { name, arguments: args } };
      });
      if (normalizedCalls.some(call => !call)) return "A previous tool call is not recognized.";
      if (!content.trim() && normalizedCalls.length === 0) return "An assistant message cannot be empty.";
      messages.push({
        role,
        content: content || null,
        ...(normalizedCalls.length > 0 ? { tool_calls: normalizedCalls } : {})
      });
      total += content.length;
    } else {
      if (content.length > 32000) return "A single message cannot exceed 32000 characters.";
      if (Array.isArray(entry?.images) && entry.images.length > 0) {
        return "Local filesystem tools are text-only. Remove image attachments or use a normal chat.";
      }
      if (!content.trim()) return "Message content cannot be empty.";
      total += content.length;
      messages.push({ role, content });
    }
    if (total > MAX_TOTAL_CHARS) return "The conversation is too large. Start a new chat or shorten your messages.";
  }
  const lastRole = messages[messages.length - 1]?.role;
  if (lastRole !== "user" && lastRole !== "tool") {
    return "The last desktop tool message must be a user message or a tool result.";
  }
  return { messages };
}

function cleanupDesktopRuns() {
  const now = Date.now();
  for (const [id, run] of desktopRuns) {
    if (now - run.createdAt > DESKTOP_RUN_TTL_MS) desktopRuns.delete(id);
  }
}

// Limits enforced before any provider call are still context-limit failures.
// The 32,000-character single-message cap stays an oversize error because it is
// not evidence that the conversation window is exhausted.
const PRE_PROVIDER_CONTEXT_LIMIT =
  /at most \d+ messages|conversation is too large|too large to replay|too long for this (?:model|provider)/i;

function sendValidationFailure(res, message) {
  return res.status(400).json({
    message,
    ...(PRE_PROVIDER_CONTEXT_LIMIT.test(message) ? { code: "context_limit" } : {})
  });
}

function parseMessageId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value.trim()) ? value.trim() : "";
}

function generatedArtifactTitle(messages) {
  const firstUser = messages.find(message => message.role === "user");
  const text = String(firstUser?.content || "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 80) : "Generated code";
}
function parseContinuation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const messageId = parseMessageId(value.messageId);
  if (!messageId) {
    throw new ProviderError("Choose a saved partial response to continue.", 400, "invalid_continuation");
  }
  return { messageId };
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
  if (Array.isArray(config.freeModels) && config.freeModels.includes(model)) return true;
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
  const verifiedFreeIds = Array.isArray(config.freeModels) ? config.freeModels : [];
  if (
    requestedModel &&
    savedModelIds.length > 0 &&
    !savedModelIds.includes(requestedModel) &&
    !verifiedFreeIds.includes(requestedModel) &&
    requestedModel !== config.model
  ) {
    throw new ProviderError(
      `"${requestedModel.slice(0, 80)}" is not one of your saved or verified free models for ${config.provider}. Add it in Models settings or choose a saved model.`,
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

function artifactMeta(artifact) {
  return {
    id: String(artifact._id),
    title: artifact.title,
    status: artifact.status,
    fileCount: artifact.files.length,
    bytes: artifact.files.reduce((total, file) => total + Number(file.bytes || 0), 0)
  };
}

function artifactPayload(artifact) {
  return {
    ...artifactMeta(artifact),
    messageId: artifact.messageId || null,
    finishReason: artifact.finishReason || null,
    files: artifact.files.map(file => ({
      path: file.path,
      language: file.language,
      content: file.content,
      bytes: file.bytes,
      complete: file.complete !== false
    }))
  };
}

function storedMessage(message, prior = null) {
  const entry = {
    role: message.role,
    content: message.content
  };
  const messageId = message.messageId || prior?.messageId;
  if (messageId) entry.messageId = messageId;
  const attachments = Array.isArray(message.attachmentMeta) && message.attachmentMeta.length > 0
    ? message.attachmentMeta
    : prior?.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) entry.attachments = attachments;
  if (Array.isArray(prior?.artifacts) && prior.artifacts.length > 0) entry.artifacts = prior.artifacts;
  return entry;
}

function trimStoredMessages(messages) {
  const kept = messages.slice(-MAX_STORED_MESSAGES);
  let total = kept.reduce((sum, message) => sum + String(message.content || "").length, 0);
  while (kept.length > 2 && total > MAX_STORED_CHARS) {
    const removed = kept.shift();
    total -= String(removed?.content || "").length;
  }
  return kept;
}
async function persistConversation(userId, conversationId, messages, assistantText, assistant = {}) {
  let conversation = null;
  if (conversationId && mongoose.isValidObjectId(conversationId)) {
    conversation = await Conversation.findOne({ _id: conversationId, userId });
  }
  const previous = conversation?.messages ?? [];
  const byMessageId = new Map(previous.filter(message => message.messageId).map(message => [message.messageId, message]));
  const storedMessages = messages.map((message, index) => {
    const prior = (message.messageId && byMessageId.get(message.messageId)) ||
      (previous[index]?.role === message.role ? previous[index] : null);
    return storedMessage(message, prior);
  });
  const assistantEntry = storedMessage(
    { role: "assistant", content: assistantText, messageId: assistant.messageId },
    null
  );
  if (Array.isArray(assistant.artifacts) && assistant.artifacts.length > 0) {
    assistantEntry.artifacts = assistant.artifacts;
  }
  storedMessages.push(assistantEntry);
  const kept = trimStoredMessages(storedMessages);
  const firstUser = kept.find(message => message.role === "user");
  const titleSource = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
  const fallbackTitle = Array.isArray(firstUser?.attachments) && firstUser.attachments.length > 0 ? "Image attachment" : "New chat";
  const title = (titleSource || fallbackTitle).slice(0, 60);
  if (!conversation) {
    const reuseId = conversationId && mongoose.isValidObjectId(conversationId) ? { _id: conversationId } : {};
    conversation = new Conversation({ ...reuseId, userId, title, messages: kept });
  } else {
    conversation.messages = kept;
    if (!conversation.title) conversation.title = title;
  }
  try {
    await conversation.save();
  } catch (error) {
    if (error?.code === 11000 && conversation.isNew) {
      conversation = new Conversation({ userId, title, messages: kept });
      await conversation.save();
    } else {
      throw error;
    }
  }

  const referenced = kept
    .flatMap(message => Array.isArray(message.artifacts) ? message.artifacts.map(artifact => artifact.id) : [])
    .filter(id => mongoose.isValidObjectId(id));
  try {
    await Artifact.deleteMany({
      userId,
      conversationId: conversation._id,
      ...(referenced.length > 0 ? { _id: { $nin: referenced } } : {})
    });
  } catch {
    /* orphaned artifacts are harmless and are hidden by conversation ownership */
  }
  return conversation;
}

function generatedArtifactStatus(finishReason, failure) {
  if (failure || (finishReason && finishReason !== "stop" && finishReason !== "end_turn" && finishReason !== "stop_sequence")) {
    return "partial";
  }
  return "complete";
}

async function persistGeneratedTurn({
  userId,
  conversationId,
  messages,
  fullText,
  messageId,
  finishReason,
  failure,
  title,
  requestId
}) {
  const status = generatedArtifactStatus(finishReason, failure);
  const targetConversationId = conversationId && mongoose.isValidObjectId(conversationId)
    ? conversationId
    : new mongoose.Types.ObjectId();
  const saved = await saveGeneratedArtifact({
    userId,
    conversationId: targetConversationId,
    messageId,
    fullText,
    status,
    finishReason,
    title,
    requestId
  });
  let summary = fullText;
  if (saved.artifact) summary = saved.summary || "Generated a code artifact.";
  else if (saved.error) {
    summary = fullText.length <= MAX_ASSISTANT_MESSAGE_CHARS
      ? fullText
      : "Generated code is available in this response, but it could not be saved to your history. Copy or download it now.";
  }
  const artifacts = saved.artifact ? [artifactMeta(saved.artifact)] : [];
  const conversation = await persistConversation(
    userId,
    String(targetConversationId),
    messages,
    summary,
    { messageId, artifacts }
  );
  return { conversation, artifact: saved.artifact, artifactError: saved.error, summary };
}
async function prepareContinuation(userId, conversationId, continuation, messages) {
  if (!conversationId || !mongoose.isValidObjectId(conversationId)) {
    throw new ProviderError("Open the saved conversation before continuing its response.", 400, "continuation_unavailable");
  }
  const conversation = await Conversation.findOne({ _id: conversationId, userId });
  if (!conversation) {
    throw new ProviderError("That conversation was not found. Reload it and try again.", 404, "conversation_not_found");
  }
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant" || last.messageId !== continuation.messageId) {
    throw new ProviderError("Reload the conversation before continuing this response.", 400, "invalid_continuation");
  }
  const target = conversation.messages.find(message => message.messageId === continuation.messageId && message.role === "assistant");
  if (!target) {
    throw new ProviderError("That partial response is no longer available. Retry the original request instead.", 404, "continuation_unavailable");
  }
  const artifact = await Artifact.findOne({
    userId,
    conversationId,
    messageId: continuation.messageId
  });
  if (artifact) {
    const plan = continuationPlan(artifact);
    return { conversation, target, artifact, plan, kind: "artifact" };
  }
  const content = String(target.content || last.content || "");
  if (!content.trim()) {
    throw new ProviderError("There is no partial response to continue. Retry the original request instead.", 400, "continuation_unavailable");
  }
  const excerpt = content.length > 12000 ? content.slice(-12000) : content;
  return {
    conversation,
    target,
    artifact: null,
    kind: "text",
    plan: {
      targetPath: "",
      prompt: [
        "Continue the incomplete assistant response exactly from where it stopped.",
        "Return only the missing continuation. Do not repeat existing content, do not add markdown fences around the whole answer, and do not add commentary about continuing.",
        "",
        "--- BEGIN EXISTING RESPONSE ---",
        excerpt,
        "--- END EXISTING RESPONSE ---"
      ].join("\n")
    }
  };
}

async function persistContinuation({ conversation, target, artifact, plan, kind, fullText, complete, finishReason }) {
  if (kind === "artifact") {
    const updated = applyContinuationFile(artifact, plan.targetPath, fullText, { complete });
    artifact.files = updated.files;
    artifact.status = complete ? "complete" : "partial";
    artifact.finishReason = finishReason || null;
    await artifact.save();
    const meta = artifactMeta(artifact);
    target.artifacts = [meta];
    conversation.markModified("messages");
    await conversation.save();
    return {
      artifact: artifactPayload(artifact),
      continuedFile: {
        path: updated.file.path,
        content: updated.file.content,
        complete: updated.file.complete
      }
    };
  }
  const merged = mergeContinuation(target.content, fullText, plan.targetPath);
  if (merged.length > 32000) {
    throw new ArtifactError(
      "This response is too large to continue in a normal chat message. Retry the original request so the code can be saved as an artifact.",
      "continuation_too_large"
    );
  }
  target.content = merged;
  conversation.markModified("messages");
  await conversation.save();
  return { content: merged };
}

async function saveGeneratedArtifact({
  userId,
  conversationId,
  messageId,
  fullText,
  status,
  finishReason,
  title,
  requestId
}) {
  let built;
  try {
    built = buildCodeArtifact(fullText, { status, finishReason });
  } catch (error) {
    if (error instanceof ArtifactError) {
      return { artifact: null, summary: "", error };
    }
    throw error;
  }
  if (!built) return { artifact: null, summary: null, error: null };
  try {
    const artifact = await Artifact.findOneAndUpdate(
      { userId, conversationId, messageId },
      {
        $set: {
          title: String(title || "Generated code").slice(0, 120),
          status: built.status,
          finishReason: finishReason || null,
          files: built.files
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    );
    return { artifact, summary: built.summary, error: null };
  } catch (error) {
    console.error("Artifact persistence failed", {
      requestId,
      messageId,
      code: error?.code || error?.name || "unknown"
    });
    return {
      artifact: null,
      summary: built.summary,
      error: new ArtifactError(
        "The generated code could not be saved to your history. Copy or download it now, then retry if you need it preserved.",
        "artifact_persist_failed"
      )
    };
  }
}

function sendEvent(res, payload) {
  return writeSseEvent(res, payload);
}

function syntheticUpstream(content, finishReason = "stop") {
  const encoder = new TextEncoder();
  const text = String(content || "");
  const stream = new ReadableStream({
    start(controller) {
      for (let index = 0; index < text.length; index += 120) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{ delta: { content: text.slice(index, index + 120) }, finish_reason: null }]
        })}\n\n`));
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: finishReason || "stop" }]
      })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function createStreamProgress(res, messageId) {
  let codeStarted = false;
  let currentFile = "";
  let preparing = false;
  let reasoningSeen = false;
  let markerTail = "";
  return {
    onReasoning() {
      // A reasoning model can stream hundreds of thinking chunks before its first
      // answer character; without this the composer looks stalled.
      if (reasoningSeen) return;
      reasoningSeen = true;
      sendEvent(res, { type: "progress", messageId, phase: "reasoning", message: "Thinking through your request" });
    },
    onText(text) {
      const combined = `${markerTail}${text}`;
      markerTail = combined.slice(-40);
      if (!codeStarted && /```|~~~/.test(combined)) {
        codeStarted = true;
        sendEvent(res, { type: "progress", messageId, phase: "generating_code", message: "Generating your code�?�" });
      }
      if (!codeStarted) return;
      FILE_MARKER_RE.lastIndex = 0;
      let match;
      while ((match = FILE_MARKER_RE.exec(combined))) {
        const path = match[1];
        if (path && path !== currentFile) {
          currentFile = path;
          sendEvent(res, { type: "progress", messageId, phase: "generating_file", message: `Generating ${path.slice(0, 80)}�?�` });
        }
      }
    },
    preparing() {
      if (!codeStarted || preparing) return;
      preparing = true;
      sendEvent(res, { type: "progress", messageId, phase: "preparing_files", message: "Preparing filesÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦" });
    }
  };
}
function sendSseHeartbeat(res) {
  if (res.writableEnded) return;
  res.write(": keepalive\n\n");
}

function readStreamChunk(reader, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout?.();
      reject(new ProviderError("Vups v3 Galax stopped sending data before the answer was complete.", null, "timeout"));
    }, timeoutMs);
    timer.unref?.();
    reader.read().then(
      result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function vupsSafeDiagnostic(error, extra = {}) {
  const diagnostic = error?.diagnostics || {};
  const headers = diagnostic.responseHeaders || {};
  return {
    category: error?.category || diagnostic.category || "unknown",
    classification: error?.classification || diagnostic.classification || "unknown",
    retryable: error?.retryable ?? diagnostic.retryable ?? null,
    providerStatus: diagnostic.providerStatus || null,
    providerErrorCode: diagnostic.providerErrorCode || null,
    limitSource: diagnostic.limitSource || null,
    upstreamRequestId: headers["x-request-id"] || headers["request-id"] || null,
    ...extra
  };
}

function vupsFailureBody(failure, error, requestId, extra) {
  return {
    message: failure.message,
    code: failure.code,
    ...(requestId ? { requestId } : {}),
    diagnostic: vupsSafeDiagnostic(error, extra)
  };
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

function resetMetadata(error) {
  if (!Number.isFinite(error?.retryAfter) || error.retryAfter < 0) return {};
  const retryAfterSeconds = Math.floor(error.retryAfter);
  return {
    retryAfterSeconds,
    resetAt: new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
    resetSource: "retry-after"
  };
}

function sendProviderFailure(res, failure, error, requestId = null, diagnostic = null, model = null) {
  if (Number.isInteger(error?.retryAfter) && error.retryAfter >= 0) {
    res.setHeader("Retry-After", String(error.retryAfter));
  }
  return res.status(failure.status).json({
    message: failure.message,
    code: failure.code,
    ...(model ? { model } : {}),
    ...resetMetadata(error),
    ...(requestId ? { requestId } : {}),
    ...(diagnostic ? { diagnostic } : {})
  });
}

function providerFailure(provider, error) {
  // Context limits are decided by the shared classifier before provider
  // branches. Serializing them as a safe 400 keeps credential and generic
  // mappings from overwriting the decision on the way to the client.
  if (error?.category === "context_limit" || error?.code === "context_limit") {
    return {
      status: 400,
      message: CONTEXT_LIMIT_MESSAGE,
      code: "context_limit"
    };
  }
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
            "The shared free-model quota is temporarily exhausted for the whole account. Switching models will not help until it resets ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â try again later, or connect your own provider in API settings.",
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

function vupsStreamFailure(payload, { url, requestId, model, attempt }) {
  const diagnostic = buildProviderFailureDiagnostic({
    url,
    status: null,
    payload,
    context: { requestId, model, attempt }
  });
  let code = "stream_interrupted";
  if (diagnostic.category === "quota_exhausted") code = "quota_exhausted";
  else if (["rate_limit_requests", "rate_limit_tokens", "concurrency_limit", "ambiguous_rate_limit"].includes(diagnostic.category)) code = "rate_limited";
  else if (diagnostic.category === "timeout") code = "timeout";
  else if (["upstream_unavailable", "overloaded"].includes(diagnostic.category)) code = "provider_unavailable";
  else if (diagnostic.category === "invalid_model") code = "invalid_model";
  else if (diagnostic.category === "invalid_credentials") code = "invalid_api_key";
  else if (diagnostic.category === "forbidden") code = "forbidden";
  else if (diagnostic.category === "invalid_request") code = "bad_request";

  const error = new ProviderError("The provider reported an error during streaming.", null, code);
  error.category = diagnostic.category;
  error.classification = diagnostic.classification;
  error.retryable = false;
  error.diagnostics = diagnostic;
  return error;
}

// Errors delivered inside an already-open SSE stream still go through the
// shared classifier. A context-limit payload must not become a generic stream
// interruption just because the HTTP response had already started.
function streamingProviderFailure(payload, detail, model) {
  const diagnostic = buildProviderFailureDiagnostic({
    status: null,
    payload,
    context: { model, attempt: null, requestId: null }
  });
  const contextLimit = diagnostic.category === "context_limit";
  const error = new ProviderError(
    contextLimit
      ? CONTEXT_LIMIT_MESSAGE
      : detail
        ? `The provider reported an error during streaming: ${redactSecrets(detail)}`
        : "The provider reported an error during streaming.",
    null,
    contextLimit ? "context_limit" : "stream_error"
  );
  error.category = diagnostic.category;
  error.classification = diagnostic.classification;
  error.retryable = diagnostic.retryable;
  error.diagnostics = diagnostic;
  return error;
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
  if (code === "stream_interrupted" || code === "stream_error") {
    return {
      status: 502,
      message: "Vups v3 Galax's response stream ended before the answer was complete. Any generated text has been kept ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â use Continue generating to finish it, or try again.",
      code: "vups_stream_interrupted"
    };
  }
  if (code === "cancelled") {
    return {
      status: 499,
      message: "The Vups v3 Galax request was cancelled.",
      code: "vups_request_cancelled"
    };
  }
  if (code === "persist_failed") {
    return {
      status: 500,
      message: "Vups v3 Galax finished the answer, but it could not be saved to your history. Copy anything you still need, then try again.",
      code: "vups_persist_failed"
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
  const contextLimit =
    error?.category === "context_limit" ||
    code === "context_limit" ||
    code === "context_length_exceeded" ||
    /context (?:length|window)|conversation is too long|too many tokens|input length exceeds/i.test(detail);
  if (contextLimit) {
    return {
      status: 400,
      message: "This conversation is too long for Vups v3 Galax. Continue in a new chat to keep going.",
      code: "vups_context_exceeded"
    };
  }
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
    let continuation;
    try {
      continuation = parseContinuation(body.continuation);
    } catch (error) {
      if (error instanceof ProviderError) return res.status(error.status ?? 400).json({ message: error.message, code: error.code });
      throw error;
    }
    const validated = validateMessages(body.messages, { allowAssistantLast: Boolean(continuation) });
    if (typeof validated === "string") return sendValidationFailure(res, validated);
    const assistantMessageId = parseMessageId(body.assistantMessageId) || continuation?.messageId || String(new mongoose.Types.ObjectId());

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
    let continuationState = null;
    if (continuation) {
      try {
        continuationState = await prepareContinuation(req.userId, conversationId, continuation, validated.messages);
      } catch (error) {
        if (error instanceof ProviderError) {
          return res.status(error.status ?? 400).json({ message: error.message, code: error.code });
        }
        throw error;
      }
    }
    const upstreamMessages = [
      { role: "system", content: buildVupsSystemPrompt(mode) },
      ...validated.messages,
      ...(continuationState ? [{ role: "user", content: continuationState.plan.prompt }] : [])
    ];
    const execution = vupsExecutionConfiguration();

    if (!stream) {
      let result;
      let attempts = 0;
      const startedAt = Date.now();
      const requestController = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) requestController.abort();
      });
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
              maxTokens: execution.maxOutputTokens,
              reasoning: provider.reasoning,
              requestId,
              attempt: attempt + 1
            }, AbortSignal.any([requestController.signal, AbortSignal.timeout(execution.requestTimeoutMs)]));
          },
          retryOptions
        );
      } catch (error) {
        if (requestController.signal.aborted) return;
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
        return sendProviderFailure(res, failure, error, requestId, vupsSafeDiagnostic(error), VUPS_MODEL_ID);
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
      if (continuationState) {
        try {
          const continued = await persistContinuation({
            conversation: continuationState.conversation,
            target: continuationState.target,
            artifact: continuationState.artifact,
            plan: continuationState.plan,
            kind: continuationState.kind,
            fullText: result.content,
            finishReason: result.finishReason,
            complete: generatedArtifactStatus(result.finishReason, null) === "complete"
          });
          return res.json({
            conversationId: String(continuationState.conversation._id),
            model: VUPS_MODEL_ID,
            message: {
              role: "assistant",
              content: continued.content ?? continuationState.target.content,
              messageId: continuationState.target.messageId
            },
            finishReason: result.finishReason,
            ...(continued.artifact ? { artifact: continued.artifact } : {}),
            ...(continued.continuedFile ? { continuedFile: continued.continuedFile } : {})
          });
        } catch (error) {
          if (error instanceof ArtifactError) {
            return res.status(error.code === "artifact_too_large" || error.code === "continuation_too_large" ? 413 : 422).json({ message: error.message, code: error.code });
          }
          throw error;
        }
      }
      const turn = await persistGeneratedTurn({
        userId: req.userId,
        conversationId,
        messages: validated.messages,
        fullText: result.content,
        messageId: assistantMessageId,
        finishReason: result.finishReason,
        failure: null,
        title: generatedArtifactTitle(validated.messages),
        requestId
      });
      return res.json({
        conversationId: String(turn.conversation._id),
        model: VUPS_MODEL_ID,
        message: { role: "assistant", content: turn.summary, messageId: assistantMessageId },
        finishReason: result.finishReason,
        ...(turn.artifact ? { artifacts: [artifactMeta(turn.artifact)] } : {}),
        ...(turn.artifactError ? { artifactError: { code: turn.artifactError.code, message: turn.artifactError.message } } : {})
      });
    }

    let existingConversation = null;
    if (conversationId && mongoose.isValidObjectId(conversationId)) {
      existingConversation = await Conversation.findOne({ _id: conversationId, userId: req.userId }).select("_id");
    }
    const prospectiveId = existingConversation ? String(existingConversation._id) : String(new mongoose.Types.ObjectId());

    const controller = new AbortController();
    let clientAborted = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientAborted = true;
        controller.abort();
      }
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
              maxTokens: execution.maxOutputTokens,
              reasoning: provider.reasoning,
              requestId,
              attempt: attempt + 1,
              responseTimeoutMs: execution.streamStartTimeoutMs
            },
            controller.signal
          );
        },
        streamRetryOptions
      );
    } catch (error) {
      if (clientAborted) return;
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
        return sendProviderFailure(res, failure, error, requestId, vupsSafeDiagnostic(error, { phase: "start" }), VUPS_MODEL_ID);
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
    sendEvent(res, { type: "meta", conversationId: prospectiveId, messageId: assistantMessageId, model: VUPS_MODEL_ID });
    const progress = createStreamProgress(res, assistantMessageId);
    const heartbeatTimer = setInterval(() => sendSseHeartbeat(res), execution.heartbeatMs);
    heartbeatTimer.unref?.();
    res.on("close", () => clearInterval(heartbeatTimer));

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let failure = null;
    let failureReason = null;
    let finishReason = null;
    let usage = null;
    let sawTerminal = false;
    let idleTimedOut = false;
    let reasoningChars = 0;

    const handleLine = line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const raw = trimmed.slice(5).trim();
      if (!raw) return;
      if (raw === "[DONE]") {
        sawTerminal = true;
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      const streamContext = {
        url: upstream.url || provider.baseUrl,
        requestId,
        model: provider.model,
        attempt: streamAttempts || 1
      };
      if (parsed?.error) {
        failure = vupsStreamFailure(parsed, streamContext);
        failureReason = "upstream_error";
        return;
      }
      if (parsed?.type === "error") {
        failure = vupsStreamFailure(parsed, streamContext);
        failureReason = "upstream_error";
        return;
      }
      if (parsed?.type === "response.failed") {
        const payload = parsed.response?.error ? { error: parsed.response.error } : parsed;
        failure = vupsStreamFailure(payload, streamContext);
        failureReason = "upstream_error";
        return;
      }
      const choice = parsed?.choices?.[0];
      if (choice?.error) {
        failure = vupsStreamFailure({ error: choice.error }, streamContext);
        failureReason = "upstream_error";
        return;
      }
      if (choice?.finish_reason === "error") {
        failure = vupsStreamFailure(parsed, streamContext);
        failureReason = "upstream_error";
        return;
      }
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
        sawTerminal = true;
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
        if (stopReason) sawTerminal = true;
      }
      if (parsed?.type === "message_stop") sawTerminal = true;
      if ((parsed?.type === "response.completed" || parsed?.type === "response.incomplete") && parsed.response) {
        if (parsed.response.usage && typeof parsed.response.usage === "object") usage = parsed.response.usage;
        const incomplete = parsed.response.incomplete_details?.reason;
        if (typeof incomplete === "string" && incomplete) {
          finishReason = incomplete === "max_output_tokens" ? "length" : incomplete;
        } else if (parsed.response.status === "completed") {
          finishReason = finishReason ?? "stop";
        }
        sawTerminal = true;
      }
      const reasoning = extractStreamReasoning(parsed);
      if (reasoning) {
        reasoningChars += reasoning.length;
        progress.onReasoning();
      }
      const text = extractStreamText(parsed);
      if (text) {
        fullText += text;
        if (fullText.length > MAX_UPSTREAM_TEXT_CHARS) {
          failure = new ProviderError("The provider returned more text than VupsRouter can safely process.", null, "response_too_large");
          failureReason = "response_too_large";
          return;
        }
        sendEvent(res, { type: "delta", content: text });
        progress.onText(text);
      }
    };

    try {
      while (!failure && !clientAborted) {
        const { done, value } = await readStreamChunk(reader, execution.streamIdleTimeoutMs, () => {
          idleTimedOut = true;
          controller.abort();
        });
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
          if (failure) break;
        }
      }
      if (!failure && !clientAborted) {
        buffer += decoder.decode();
        for (const line of buffer.split("\n")) {
          handleLine(line);
          if (failure) break;
        }
      }
    } catch (error) {
      if (idleTimedOut) {
        failure = error instanceof ProviderError
          ? error
          : new ProviderError("Vups v3 Galax stopped sending data before the answer was complete.", null, "timeout");
        failureReason = "idle_timeout";
      } else if (!clientAborted) {
        failure = error instanceof ProviderError
          ? error
          : new ProviderError("The provider stream was interrupted.", null, "stream_interrupted");
        failureReason = failureReason || "read_error";
      }
    } finally {
      clearInterval(heartbeatTimer);
      try {
        await reader.cancel();
      } catch {
        /* stream already closed */
      }
    }

    if (!failure && !clientAborted) {
      if (fullText.length === 0) {
        failure = finishReason === "length"
          ? new ProviderError(
              reasoningChars > 0
                ? "Vups v3 Galax spent its whole output budget reasoning before writing an answer. Try a shorter prompt."
                : "Vups v3 Galax reached its output limit before writing an answer. Try a shorter prompt.",
              null,
              "output_limit"
            )
          : new ProviderError("The provider returned an empty response.", null, "empty_response");
        failureReason = "empty_response";
      } else if (!sawTerminal) {
        failure = new ProviderError("The provider stream ended before it signalled completion.", null, "stream_interrupted");
        failureReason = "eof_without_terminal";
      }
    }

    let savedArtifact = null;
    let savedContinuation = null;
    let savedContent = null;
    let artifactError = null;
    let persistFailure = null;
    let savedConversationId = prospectiveId;
    if (fullText.length > 0) {
      progress.preparing();
      try {
        if (continuationState) {
          const complete = !failure && !clientAborted && generatedArtifactStatus(finishReason, null) === "complete";
          const continued = await persistContinuation({
            conversation: continuationState.conversation,
            target: continuationState.target,
            artifact: continuationState.artifact,
            plan: continuationState.plan,
            kind: continuationState.kind,
            fullText,
            finishReason,
            complete
          });
          savedArtifact = continued.artifact || null;
          savedContinuation = continued.continuedFile || null;
          savedContent = continued.content ?? null;
          savedConversationId = String(continuationState.conversation._id);
        } else {
          const turn = await persistGeneratedTurn({
            userId: req.userId,
            conversationId: prospectiveId,
            messages: validated.messages,
            fullText,
            messageId: assistantMessageId,
            finishReason,
            failure: failure || (clientAborted ? { code: "client_aborted" } : null),
            title: generatedArtifactTitle(validated.messages),
            requestId
          });
          savedConversationId = String(turn.conversation._id);
          savedContent = turn.summary;
          savedArtifact = turn.artifact ? artifactPayload(turn.artifact) : null;
          artifactError = turn.artifactError;
        }
      } catch (error) {
        if (error instanceof ArtifactError) artifactError = error;
        else if (!failure) {
          persistFailure = new ProviderError(
            "The response was generated but could not be saved to your history.",
            null,
            "persist_failed"
          );
        }
      }
    }

    const terminal = resolveTerminalEvent({
      failure,
      artifactError,
      persistFailure,
      clientAborted
    });

    if ((artifactError || persistFailure) && !failure && !clientAborted) {
      const saveError = artifactError || persistFailure;
      logVupsOutcome({
        outcome: "completed_with_warning",
        requestId,
        model: provider.model,
        providerHost,
        attempts: streamAttempts || 1,
        totalDurationMs: Date.now() - streamStartedAt,
        error: saveError,
        finalCode: saveError.code
      });
    }

    if (terminal.type === "done") {
      sendEvent(res, {
        type: "done",
        conversationId: savedConversationId,
        messageId: assistantMessageId,
        finishReason: finishReason ?? "stop",
        model: VUPS_MODEL_ID,
        ...(savedContent ? { message: { role: "assistant", content: savedContent, messageId: assistantMessageId } } : {}),
        ...(savedArtifact ? { artifact: savedArtifact, artifacts: [savedArtifact] } : {}),
        ...(savedContinuation ? { continuedFile: savedContinuation } : {}),
        ...(terminal.saveWarning ? { saveWarning: terminal.saveWarning } : {}),
        ...(usage ? { usage } : {})
      });
    }

    if (terminal.type === "error") {
      const safe = vupsFailure(failure, { hasImages });
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
        model: VUPS_MODEL_ID,
        ...resetMetadata(failure),
        ...(requestId ? { requestId } : {}),
        messageId: assistantMessageId,
        conversationId: savedConversationId,
        partial: fullText.length > 0,
        ...(savedArtifact ? { artifact: savedArtifact, artifacts: [savedArtifact] } : {}),
        ...(savedContinuation ? { continuedFile: savedContinuation } : {}),
        diagnostic: vupsSafeDiagnostic(failure, {
          phase: "stream",
          reason: failureReason || (idleTimedOut ? "idle_timeout" : "stream_interrupted"),
          contentChars: fullText.length,
          durationMs: Date.now() - streamStartedAt,
          sawTerminal
        })
      });
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

router.post("/desktop-tools", requireAuth, chatRateLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    if (!validDesktopRunId(runId)) {
      return res.status(400).json({ message: "A valid desktop tool run id is required.", code: "invalid_run_id" });
    }
    cleanupDesktopRuns();
    let run = desktopRuns.get(runId);
    if (run && run.userId !== req.userId) {
      return res.status(403).json({ message: "That desktop tool run belongs to another account.", code: "run_forbidden" });
    }
    if (run?.busy) {
      return res.status(409).json({ message: "This desktop tool run is already waiting for a model response.", code: "run_busy" });
    }

    const validated = validateDesktopMessages(body.messages);
    if (typeof validated === "string") return sendValidationFailure(res, validated);
    const assistantMessageId = parseMessageId(body.assistantMessageId) || String(new mongoose.Types.ObjectId());
    const mode = typeof body.mode === "string" ? body.mode.trim().toLowerCase() || "general" : "general";
    if (!CHAT_MODES.has(mode)) {
      return res.status(400).json({ message: "Unknown chat mode. Choose general or motion.", code: "invalid_mode" });
    }
    const temperature =
      typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 2
        ? body.temperature
        : undefined;
    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    const requestedConfigId = typeof body.configId === "string" ? body.configId.trim() : "";
    const requestedProviderId = typeof body.providerId === "string" ? body.providerId.trim().slice(0, 80) : "";
    const requestedSource = typeof body.source === "string" ? body.source.trim().toLowerCase() : "";
    const requestedConversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    if (run && requestedConversationId && run.conversationId && requestedConversationId !== run.conversationId) {
      return res.status(400).json({ message: "This desktop tool run is attached to another conversation.", code: "run_conversation_mismatch" });
    }

    await connectToDatabase();
    if (req.user?.aiEnabled === false) {
      return res.status(403).json({ message: "AI chat has been disabled for your account by an administrator.", code: "ai_disabled" });
    }

    let provider;
    let model;
    try {
      if (body.vups === true) {
        provider = vupsProviderForChat({ images: false });
        model = requestedModel || provider.model || VUPS_MODEL_ID;
        if (requestedModel && requestedModel !== VUPS_MODEL_ID) {
          return res.status(400).json({ message: "This route only serves Vups v3 Galax.", code: "invalid_model" });
        }
      } else {
        provider = await resolveProvider(req.userId, requestedModel, requestedConfigId, requestedSource, requestedProviderId);
        model = requestedModel || provider.defaultModel;
      }
    } catch (error) {
      if (error instanceof ProviderError) {
        return res.status(error.status ?? 400).json({ message: error.message, code: error.code });
      }
      throw error;
    }
    if (!model) {
      return res.status(400).json({ message: "Select a model before using local filesystem tools.", code: "no_model" });
    }
    if (!providerSupportsToolCalling(provider, model)) {
      return res.status(400).json({
        message: "This model's provider does not support tool calling in VupsRouter. Choose an OpenAI-compatible chat model to use local Windows filesystem tools.",
        code: "tool_calling_unsupported"
      });
    }

    if (!run) {
      run = {
        userId: req.userId,
        conversationId: requestedConversationId,
        createdAt: Date.now(),
        steps: 0,
        quotaConsumed: false,
        busy: false
      };
      desktopRuns.set(runId, run);
    }
    if (run.steps >= MAX_DESKTOP_STEPS) {
      return res.status(429).json({
        message: "The assistant used too many local filesystem tool rounds. Ask a narrower question and try again.",
        code: "tool_round_limit"
      });
    }
    if (!acquireSlot(req.userId)) {
      return res.status(429).json({
        message: "Too many AI requests are already in flight for your account. Wait for them to finish and try again.",
        code: "concurrency_limit"
      });
    }

    run.busy = true;
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      if (!run.quotaConsumed) {
        try {
          await consumeDailyQuota(req.userId);
          run.quotaConsumed = true;
        } catch (error) {
          if (error instanceof UsageError) return res.status(429).json({ message: error.message, code: error.code });
          throw error;
        }
      }

      const systemPrompt = body.vups === true
        ? `${buildVupsSystemPrompt(mode)}${DESKTOP_TOOL_PROMPT}`
        : `${CHAT_MODES.get(mode)}${DESKTOP_TOOL_PROMPT}`;
      const upstreamMessages = [
        { role: "system", content: systemPrompt },
        ...validated.messages
      ];

      let result;
      try {
        result = await chatCompletion(
          {
            baseUrl: provider.baseUrl,
            apiKey: provider.apiKey,
            providerType: provider.providerType,
            model,
            messages: upstreamMessages,
            temperature,
            maxTokens: provider.maxTokens,
            reasoning: provider.reasoning,
            tools: DESKTOP_TOOLS,
            toolChoice: "auto",
            requestId: req.requestId
          },
          controller.signal
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ProviderError) {
          logProviderFailure(provider, error);
          return res.status(error.status && error.status >= 400 ? error.status : 502).json({
            message: error.message,
            code: error.code || "provider_error"
          });
        }
        throw error;
      }

      const toolCalls = normalizeDesktopToolCalls(result.toolCalls);
      if (toolCalls.length > 0) {
        run.steps += 1;
        return res.json({
          runId,
          type: "tool_calls",
          conversationId: run.conversationId,
          content: result.content,
          finishReason: result.finishReason,
          toolCalls,
          assistantMessage: {
            role: "assistant",
            content: result.content || null,
            tool_calls: toolCalls
          },
          model
        });
      }

      const content = String(result.content || "").trim();
      if (!content) {
        return res.status(502).json({
          message: "The model returned an empty answer after the local tool step. Try again.",
          code: "empty_response"
        });
      }
      const persistMessages = validated.messages.filter(message =>
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string" &&
        message.content.trim()
      );
      const turn = await persistGeneratedTurn({
        userId: req.userId,
        conversationId: run.conversationId,
        messages: persistMessages,
        fullText: content,
        messageId: assistantMessageId,
        finishReason: result.finishReason,
        failure: null,
        title: generatedArtifactTitle(persistMessages),
        requestId: req.requestId
      });
      desktopRuns.delete(runId);
      return res.json({
        runId,
        type: "final",
        conversationId: String(turn.conversation._id),
        message: { role: "assistant", content: turn.summary, messageId: assistantMessageId },
        content: turn.summary,
        finishReason: result.finishReason,
        ...(turn.artifact ? { artifact: artifactPayload(turn.artifact), artifacts: [artifactPayload(turn.artifact)] } : {}),
        ...(turn.artifactError ? { artifactError: { code: turn.artifactError.code, message: turn.artifactError.message } } : {})
      });
    } finally {
      run.busy = false;
      releaseSlot(req.userId);
    }
  } catch (error) {
    return next(error);
  }
});

router.post("/", requireAuth, chatRateLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    let continuation;
    try {
      continuation = parseContinuation(body.continuation);
    } catch (error) {
      if (error instanceof ProviderError) return res.status(error.status ?? 400).json({ message: error.message, code: error.code });
      throw error;
    }
    const validated = validateMessages(body.messages, { allowAssistantLast: Boolean(continuation) });
    if (typeof validated === "string") return sendValidationFailure(res, validated);
    const assistantMessageId = parseMessageId(body.assistantMessageId) || continuation?.messageId || String(new mongoose.Types.ObjectId());

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
    let continuationState = null;
    if (continuation) {
      try {
        continuationState = await prepareContinuation(req.userId, conversationId, continuation, validated.messages);
      } catch (error) {
        if (error instanceof ProviderError) {
          return res.status(error.status ?? 400).json({ message: error.message, code: error.code });
        }
        throw error;
      }
    }
    const upstreamMessages = [
      { role: "system", content: CHAT_MODES.get(mode) },
      ...validated.messages,
      ...(continuationState ? [{ role: "user", content: continuationState.plan.prompt }] : [])
    ];

    if (!stream) {
      let result;
      let usedModel = model;
      let fallbackUsed = false;
      let pluginRun = null;
      try {
        pluginRun = await runPluginToolLoop({
          userId: req.userId,
          provider,
          model,
          messages: upstreamMessages,
          temperature,
          maxTokens: provider.maxTokens,
          reasoning: provider.reasoning,
          requestId: req.requestId
        });
      } catch (error) {
        // A provider that fails mid tool loop must not lose the reply; fall back
        // to the plain completion below.
        if (!(error instanceof ProviderError)) throw error;
        logProviderFailure(provider, error);
        pluginRun = null;
      }
      while (!pluginRun) {
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
          return sendProviderFailure(
            res,
            failure,
            error,
            null,
            vupsSafeDiagnostic(error),
            usedModel
          );
        }
      }
      if (pluginRun) result = pluginRun;
      const pluginToolsUsed = pluginRun?.toolsUsed || [];
      if (continuationState) {
        try {
          const continued = await persistContinuation({
            conversation: continuationState.conversation,
            target: continuationState.target,
            artifact: continuationState.artifact,
            plan: continuationState.plan,
            kind: continuationState.kind,
            fullText: result.content,
            finishReason: result.finishReason,
            complete: generatedArtifactStatus(result.finishReason, null) === "complete"
          });
          return res.json({
            conversationId: String(continuationState.conversation._id),
            message: {
              role: "assistant",
              content: continued.content ?? continuationState.target.content,
              messageId: continuationState.target.messageId
            },
            finishReason: result.finishReason,
            ...(continued.artifact ? { artifact: continued.artifact, artifacts: [continued.artifact] } : {}),
            ...(continued.continuedFile ? { continuedFile: continued.continuedFile } : {}),
            ...(pluginToolsUsed.length > 0 ? { toolsUsed: pluginToolsUsed } : {}),
            ...(fallbackUsed ? { model: usedModel, fallbackUsed: true } : {})
          });
        } catch (error) {
          if (error instanceof ArtifactError) {
            return res.status(error.code === "artifact_too_large" || error.code === "continuation_too_large" ? 413 : 422).json({ message: error.message, code: error.code });
          }
          throw error;
        }
      }
      const turn = await persistGeneratedTurn({
        userId: req.userId,
        conversationId,
        messages: validated.messages,
        fullText: result.content,
        messageId: assistantMessageId,
        finishReason: result.finishReason,
        failure: null,
        title: generatedArtifactTitle(validated.messages),
        requestId: req.requestId
      });
      return res.json({
        conversationId: String(turn.conversation._id),
        message: { role: "assistant", content: turn.summary, messageId: assistantMessageId },
        finishReason: result.finishReason,
        ...(turn.artifact ? { artifact: artifactPayload(turn.artifact), artifacts: [artifactPayload(turn.artifact)] } : {}),
        ...(turn.artifactError ? { artifactError: { code: turn.artifactError.code, message: turn.artifactError.message } } : {}),
        ...(pluginToolsUsed.length > 0 ? { toolsUsed: pluginToolsUsed } : {}),
        ...(fallbackUsed ? { model: usedModel, fallbackUsed: true } : {})
      });
    }

    let existingConversation = null;
    if (conversationId && mongoose.isValidObjectId(conversationId)) {
      existingConversation = await Conversation.findOne({ _id: conversationId, userId: req.userId }).select("_id");
    }
    const prospectiveId = existingConversation ? String(existingConversation._id) : String(new mongoose.Types.ObjectId());

    const controller = new AbortController();
    let clientAborted = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientAborted = true;
        controller.abort();
      }
    });

    let toolRun = null;
    try {
      toolRun = await runPluginToolLoop({
        userId: req.userId,
        provider,
        model,
        messages: upstreamMessages,
        temperature,
        maxTokens: provider.maxTokens,
        reasoning: provider.reasoning,
        signal: controller.signal,
        requestId: req.requestId
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn("Plugin tool loop skipped:", error?.name || "UnknownError", error?.code || "");
    }

    let upstream = toolRun ? syntheticUpstream(toolRun.content, toolRun.finishReason) : null;
    let usedModel = model;
    let fallbackUsed = false;
    while (!upstream) {
      try {
        // OpenRouter free models share an upstream pool and answer with a
        // transient 429 often enough that a personal key deserves the same
        // bounded retry the shared route already gets. A shared provider with a
        // configured fallback fails over to it instead of retrying in place.
        const streamRetry = vupsRetryOptions();
        if (provider.shared && provider.fallbackModel) streamRetry.maxRetries = 0;
        upstream = await withProviderRetry(
          () => startChatCompletionStream(
            { baseUrl: provider.baseUrl, apiKey: provider.apiKey, providerType: provider.providerType, model: usedModel, messages: upstreamMessages, temperature, maxTokens: provider.maxTokens, reasoning: provider.reasoning },
            controller.signal
          ),
          { ...streamRetry, signal: controller.signal }
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
          return sendProviderFailure(
            res,
            failure,
            error,
            null,
            vupsSafeDiagnostic(error),
            usedModel
          );
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
      messageId: assistantMessageId,
      ...(fallbackUsed ? { model: usedModel, fallbackUsed: true } : {})
    });
    if (toolRun?.toolsUsed?.length) {
      sendEvent(res, {
        type: "progress",
        messageId: assistantMessageId,
        phase: "plugin_tools",
        message: `Used ${toolRun.toolsUsed.length} plugin tool${toolRun.toolsUsed.length === 1 ? "" : "s"}.`
      });
    }
    const progress = createStreamProgress(res, assistantMessageId);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let failure = null;
    let finishReason = null;
    let usage = null;
    let reasoningChars = 0;

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
          if (parsed?.type === "error" && (parsed.code || parsed.message)) {
            failure = streamingProviderFailure(
              parsed,
              typeof parsed.message === "string" ? parsed.message : "",
              usedModel
            );
            break;
          }
          if (parsed?.error) {
            const detail =
              typeof parsed.error === "string"
                ? parsed.error
                : typeof parsed.error?.message === "string"
                  ? parsed.error.message
                  : "";
            failure = streamingProviderFailure(parsed, detail, usedModel);
            break;
          }
          if (parsed?.type === "response.failed") {
            const detail = parsed.response?.error?.message;
            failure = streamingProviderFailure(
              { error: parsed.response?.error },
              typeof detail === "string" ? detail : "",
              usedModel
            );
            break;
          }
          const choice = parsed?.choices?.[0];
          if (choice?.error) {
            const detail = typeof choice.error?.message === "string" ? choice.error.message : "";
            failure = streamingProviderFailure({ error: choice.error }, detail, usedModel);
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
          const reasoning = extractStreamReasoning(parsed);
          if (reasoning) {
            reasoningChars += reasoning.length;
            progress.onReasoning();
          }
          const text = extractStreamText(parsed);
          if (text) {
            fullText += text;
            if (fullText.length > MAX_UPSTREAM_TEXT_CHARS) {
              failure = new ProviderError("The provider returned more text than VupsRouter can safely process.", null, "response_too_large");
              break;
            }
            sendEvent(res, { type: "delta", content: text });
            progress.onText(text);
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
        ? new ProviderError(
            reasoningChars > 0
              ? "The model spent its whole output budget reasoning before writing an answer. Raise the maximum output tokens in API settings, or choose another model."
              : "The model reached its output limit before writing an answer. Try a shorter prompt or choose another model.",
            null,
            "output_limit"
          )
        : new ProviderError("The provider returned an empty response. Check the model ID and try again.", null, "empty_response");
    }

    let savedArtifact = null;
    let savedContinuation = null;
    let savedContent = null;
    let artifactError = null;
    let persistFailure = null;
    let savedConversationId = prospectiveId;
    if (fullText.length > 0) {
      progress.preparing();
      try {
        if (continuationState) {
          const complete = !failure && !clientAborted && generatedArtifactStatus(finishReason, null) === "complete";
          const continued = await persistContinuation({
            conversation: continuationState.conversation,
            target: continuationState.target,
            artifact: continuationState.artifact,
            plan: continuationState.plan,
            kind: continuationState.kind,
            fullText,
            finishReason,
            complete
          });
          savedArtifact = continued.artifact || null;
          savedContinuation = continued.continuedFile || null;
          savedContent = continued.content ?? continuationState.target.content;
          savedConversationId = String(continuationState.conversation._id);
        } else {
          const turn = await persistGeneratedTurn({
            userId: req.userId,
            conversationId: prospectiveId,
            messages: validated.messages,
            fullText,
            messageId: assistantMessageId,
            finishReason,
            failure: failure || (clientAborted ? { code: "client_aborted" } : null),
            title: generatedArtifactTitle(validated.messages),
            requestId: req.requestId
          });
          savedConversationId = String(turn.conversation._id);
          savedContent = turn.summary;
          savedArtifact = turn.artifact ? artifactPayload(turn.artifact) : null;
          artifactError = turn.artifactError;
        }
      } catch (error) {
        if (error instanceof ArtifactError) artifactError = error;
        else if (!failure) {
          persistFailure = new ProviderError(
            "The response was generated but could not be saved to your history.",
            null,
            "persist_failed"
          );
        }
      }
    }

    const terminal = resolveTerminalEvent({
      failure,
      artifactError,
      persistFailure,
      clientAborted
    });

    if ((artifactError || persistFailure) && !failure && !clientAborted) {
      logProviderFailure(provider, artifactError || persistFailure);
    }

    if (terminal.type === "done") {
      sendEvent(res, {
        type: "done",
        conversationId: savedConversationId,
        messageId: assistantMessageId,
        finishReason: finishReason ?? "stop",
        ...(savedContent ? { message: { role: "assistant", content: savedContent, messageId: assistantMessageId } } : {}),
        ...(savedArtifact ? { artifact: savedArtifact, artifacts: [savedArtifact] } : {}),
        ...(savedContinuation ? { continuedFile: savedContinuation } : {}),
        ...(terminal.saveWarning ? { saveWarning: terminal.saveWarning } : {}),
        ...(usage ? { usage } : {})
      });
    }

    if (terminal.type === "error") {
      logProviderFailure(provider, failure);
      sendEvent(res, {
        type: "error",
        message: failure.message,
        code: failure.code,
        model: usedModel,
        ...resetMetadata(failure),
        ...(req.requestId ? { requestId: req.requestId } : {}),
        messageId: assistantMessageId,
        conversationId: savedConversationId,
        partial: fullText.length > 0,
        ...(savedArtifact ? { artifact: savedArtifact, artifacts: [savedArtifact] } : {}),
        ...(savedContinuation ? { continuedFile: savedContinuation } : {}),
        ...(failure ? { diagnostic: vupsSafeDiagnostic(failure) } : {})
      });
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
