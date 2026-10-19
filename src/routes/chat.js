import { Router } from "express";
import mongoose from "mongoose";
import connectToDatabase from "../db.js";
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

const router = Router();

const SYSTEM_PROMPT =
  "You are the VupsRouter AI assistant. VupsRouter helps developers and users explore AI models — hosted providers, OpenAI-compatible APIs, and locally-run open-weight models. Be concise, helpful, and honest about model limitations. Use markdown when it improves clarity. Do not pretend to know real-time facts you do not have.";

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

async function resolveProvider(userId) {
  const config = await ProviderConfig.findOne({ userId }).select("+encryptedApiKey");
  if (!config) {
    throw new ProviderError("Configure your AI provider in Settings first.", 400, "not_configured");
  }
  let apiKey;
  try {
    apiKey = decryptSecret(config.encryptedApiKey);
  } catch {
    throw new ProviderError("The stored API key could not be decrypted. Re-enter and save your key in Settings.", 500, "key_decryption_failed");
  }
  return {
    provider: config.provider,
    baseUrl: normalizeBaseUrl(config.baseUrl),
    defaultModel: config.model || "",
    apiKey
  };
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

function providerFailureStatus(error) {
  return 400;
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
    let provider;
    try {
      provider = await resolveProvider(req.userId);
    } catch (error) {
      if (error instanceof ProviderError) {
        return res.status(error.code === "key_decryption_failed" ? 500 : 400).json({ message: error.message, code: error.code });
      }
      throw error;
    }

    const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
    const model = requestedModel || provider.defaultModel;
    if (!model) return res.status(400).json({ message: "Select a model in Settings or choose one from the model picker.", code: "no_model" });

    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    const upstreamMessages = [{ role: "system", content: SYSTEM_PROMPT }, ...validated.messages];

    if (!stream) {
      let reply;
      try {
        reply = await chatCompletion(
          { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, messages: upstreamMessages, temperature },
          undefined
        );
      } catch (error) {
        if (error instanceof ProviderError) {
          return res.status(providerFailureStatus(error)).json({ message: error.message, code: error.code });
        }
        throw error;
      }
      const conversation = await persistConversation(req.userId, conversationId, validated.messages, reply);
      return res.json({
        conversationId: String(conversation._id),
        message: { role: "assistant", content: reply }
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
        { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model, messages: upstreamMessages, temperature },
        controller.signal
      );
    } catch (error) {
      const message = error instanceof ProviderError ? error.message : "Could not reach the provider.";
      if (!controller.signal.aborted) sendEvent(res, { type: "error", message });
      if (!res.writableEnded) res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let failure = null;

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
          sendEvent(res, { type: "done", conversationId: String(conversation._id) });
        }
      } catch (error) {
        if (!failure) failure = new ProviderError("The response was generated but could not be saved to your history.", null, "persist_failed");
      }
    }

    if (failure && !controller.signal.aborted) sendEvent(res, { type: "error", message: failure.message, code: failure.code });
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
