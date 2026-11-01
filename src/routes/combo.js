import { Router } from "express";
import mongoose from "mongoose";
import connectToDatabase from "../db.js";
import Conversation from "../conversation.js";
import { chatRateLimiter, requireAuth, settingsRateLimiter } from "../middleware.js";
import { acquireSlot, consumeDailyQuota, releaseSlot, UsageError } from "../usage.js";
import { saveWarningFor, writeSseEvent } from "../chatTerminal.js";
import { parseMessageId, persistConversation } from "./chat.js";
import ComboConfig, {
  COMBO_MAX_SELECTED_MODELS,
  comboConfigForUser,
  comboModelKey,
  normalizeComboSettings,
  publicComboConfig,
  sanitizeSelectedModel
} from "../comboConfig.js";
import { comboCatalogForUser } from "../comboCatalog.js";
import { ComboCancelledError, runAvailabilityChecks } from "../comboAvailability.js";
import { ComboError, runComboChat } from "../comboOrchestrator.js";

const router = Router();

router.use(requireAuth);

const COMBO_SSE_HEARTBEAT_MS = 15000;
const MAX_COMBO_MESSAGES = 40;
const MAX_COMBO_MESSAGE_CHARS = 24000;
const MAX_COMBO_TOTAL_CHARS = 60000;

function sendEvent(res, payload) {
  writeSseEvent(res, payload);
}

// A chat turn receives its conversation id before the run starts, exactly like
// the single-model route: an unknown or foreign conversationId never errors, it
// simply starts a new conversation owned by this user.
async function prospectiveConversationId(userId, value) {
  const conversationId = typeof value === "string" ? value : "";
  if (conversationId && mongoose.isValidObjectId(conversationId)) {
    const existing = await Conversation.findOne({ _id: conversationId, userId }).select("_id");
    if (existing) return String(existing._id);
  }
  return String(new mongoose.Types.ObjectId());
}

function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return "Add a message first.";
  if (input.length > MAX_COMBO_MESSAGES) {
    return `Vups Combo AI accepts at most ${MAX_COMBO_MESSAGES} messages per request. Start a new conversation.`;
  }
  let total = 0;
  const messages = [];
  for (const raw of input) {
    const role = raw?.role;
    if (role !== "user" && role !== "assistant") return "Messages must be from the user or assistant.";
    if (Array.isArray(raw?.images) && raw.images.length > 0) {
      return "Vups Combo AI currently supports text requests only. Remove image attachments to continue.";
    }
    const content = typeof raw?.content === "string" ? raw.content.trim() : "";
    if (!content) return "Each message needs some text.";
    if (content.length > MAX_COMBO_MESSAGE_CHARS) {
      return `A message is too long. Keep each message under ${MAX_COMBO_MESSAGE_CHARS.toLocaleString()} characters.`;
    }
    total += content.length;
    if (total > MAX_COMBO_TOTAL_CHARS) {
      return "This conversation is too long for a Combo run. Start a new conversation or shorten the prompt.";
    }
    messages.push({ role, content });
  }
  if (messages[messages.length - 1].role !== "user") return "The last message must be from you.";
  return messages;
}

function canonicalSelection(input, catalog) {
  if (!Array.isArray(input)) return { error: "Selected models must be a list." };
  if (input.length > COMBO_MAX_SELECTED_MODELS) {
    return { error: `Vups Combo AI supports up to ${COMBO_MAX_SELECTED_MODELS} selected models.` };
  }
  const byKey = new Map(catalog.models.map(model => [model.key, model]));
  const selected = [];
  const seen = new Set();
  for (const raw of input) {
    const normalized = sanitizeSelectedModel(raw);
    if (!normalized) return { error: "One of the selected models is invalid. Refresh the model list." };
    const canonical = byKey.get(normalized.key) || byKey.get(comboModelKey(normalized));
    if (!canonical) {
      return { error: `"${normalized.label}" is no longer available. Refresh the model list and select it again.` };
    }
    if (seen.has(canonical.key)) continue;
    seen.add(canonical.key);
    const { available, sharedStatus, vision, group, ...descriptor } = canonical;
    selected.push(descriptor);
  }
  return { selected };
}

router.get("/", settingsRateLimiter, async (req, res, next) => {
  try {
    await connectToDatabase();
    const [config, catalog] = await Promise.all([
      comboConfigForUser(req.userId),
      comboCatalogForUser(req.userId)
    ]);
    return res.json({ config: publicComboConfig(config), catalog });
  } catch (error) {
    return next(error);
  }
});

router.put("/", settingsRateLimiter, async (req, res, next) => {
  try {
    await connectToDatabase();
    const body = req.body || {};
    const catalog = await comboCatalogForUser(req.userId);
    const existing = await ComboConfig.findOne({ userId: req.userId });
    const selection = canonicalSelection(
      body.selected === undefined ? existing?.selected || [] : body.selected,
      catalog
    );
    if (selection.error) return res.status(400).json({ message: selection.error, code: "invalid_selection" });

    const previousAvailability = Array.isArray(existing?.availability) ? existing.availability : [];
    const selectedKeys = new Set(selection.selected.map(model => model.key));
    const availability = previousAvailability.filter(entry => selectedKeys.has(entry.key));
    const update = {
      enabled: typeof body.enabled === "boolean" ? body.enabled : existing?.enabled !== false,
      selected: selection.selected,
      settings: normalizeComboSettings(body.settings ?? existing?.settings),
      availability
    };
    const config = await ComboConfig.findOneAndUpdate(
      { userId: req.userId },
      { $set: update },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    );
    return res.json({ config: publicComboConfig(config), catalog });
  } catch (error) {
    return next(error);
  }
});

router.post("/availability", chatRateLimiter, async (req, res, next) => {
  try {
    await connectToDatabase();
    const config = await comboConfigForUser(req.userId);
    if (!config.selected || config.selected.length === 0) return res.json({ models: [], checkedAt: null });
    const keys = Array.isArray(req.body?.keys) && req.body.keys.length > 0
      ? new Set(req.body.keys.map(key => String(key)).filter(Boolean))
      : null;
    const descriptors = keys ? config.selected.filter(model => keys.has(model.key)) : config.selected;
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const availability = await runAvailabilityChecks({
      userId: req.userId,
      config,
      descriptors,
      force: req.body?.force === true,
      signal: controller.signal,
      concurrency: Math.max(1, Math.min(4, Number(config.settings?.maxConcurrent) || 3))
    });
    if (controller.signal.aborted) return;
    return res.json({
      models: availability.models,
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    if (error instanceof ComboCancelledError) return;
    return next(error);
  }
});

router.post("/chat", chatRateLimiter, async (req, res, next) => {
  let heartbeatTimer = null;
  try {
    await connectToDatabase();
    if (req.user?.aiEnabled === false) {
      return res.status(403).json({ message: "AI chat has been disabled for your account by an administrator.", code: "ai_disabled" });
    }
    const messages = validateMessages(req.body?.messages);
    if (typeof messages === "string") return res.status(400).json({ message: messages, code: "invalid_messages" });

    const config = await comboConfigForUser(req.userId);
    if (!config.enabled) {
      return res.status(403).json({ message: "Vups Combo AI is disabled. Enable it in Combo settings.", code: "combo_disabled" });
    }
    if (!config.selected || config.selected.length === 0) {
      return res.status(400).json({ message: "Select at least one model for Vups Combo AI.", code: "no_models_selected" });
    }

    if (!acquireSlot(req.userId)) {
      return res.status(429).json({
        message: "Too many AI requests are already in flight for your account. Wait for them to finish and try again.",
        code: "concurrency_limit"
      });
    }
    try {
      await consumeDailyQuota(req.userId);
    } catch (error) {
      releaseSlot(req.userId);
      if (error instanceof UsageError) return res.status(429).json({ message: error.message, code: error.code });
      throw error;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, COMBO_SSE_HEARTBEAT_MS);
    heartbeatTimer.unref?.();

    const assistantMessageId = parseMessageId(req.body?.assistantMessageId) || String(new mongoose.Types.ObjectId());
    const prospectiveId = await prospectiveConversationId(req.userId, req.body?.conversationId);

    const controller = new AbortController();
    let clientAborted = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientAborted = true;
        controller.abort();
      }
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      releaseSlot(req.userId);
    });

    sendEvent(res, {
      type: "meta",
      conversationId: prospectiveId,
      messageId: assistantMessageId,
      selectedCount: config.selected.length,
      strategy: config.settings?.strategy || "parallel"
    });
    const result = await runComboChat({
      userId: req.userId,
      config,
      messages,
      signal: controller.signal,
      onEvent: event => sendEvent(res, event)
    });
    if (controller.signal.aborted || clientAborted) return;

    const text = result.finalText;
    for (let index = 0; index < text.length; index += 160) {
      if (controller.signal.aborted) return;
      sendEvent(res, { type: "delta", content: text.slice(index, index + 160) });
      await new Promise(resolve => setImmediate(resolve));
    }
    if (controller.signal.aborted) return;

    // A turn the user cannot reload is a turn that never happened, so the run is
    // written to the same conversation history as a single-model answer. A failed
    // write warns on a completed turn; it never pretends generation failed.
    let saveWarning = null;
    if (text.trim().length > 0) {
      try {
        await persistConversation(req.userId, prospectiveId, messages, text, {
          messageId: assistantMessageId
        });
      } catch (error) {
        saveWarning = saveWarningFor(error);
      }
    }

    sendEvent(res, {
      type: "done",
      ...result.meta,
      conversationId: prospectiveId,
      messageId: assistantMessageId,
      ...(saveWarning ? { saveWarning } : {})
    });
    res.end();
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (error instanceof ComboCancelledError) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (error instanceof ComboError) {
      if (res.headersSent) {
        sendEvent(res, { type: "error", code: error.code, message: error.message });
        res.end();
        return;
      }
      return res.status(error.status).json({ message: error.message, code: error.code });
    }
    if (res.headersSent) {
      console.error("[combo] run failed:", error?.name || "UnknownError", error?.code || "");
      sendEvent(res, {
        type: "error",
        code: "combo_failed",
        message: "Vups Combo AI could not complete this run. Your selections are saved; try again."
      });
      if (!res.writableEnded) res.end();
      return;
    }
    return next(error);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
});

export default router;
