import { Router } from "express";
import mongoose from "mongoose";
import connectToDatabase from "../db.js";
import Conversation from "../conversation.js";
import Artifact from "../artifact.js";
import { requireAuth } from "../middleware.js";

const router = Router();

const MAX_HANDOFF_CHARS = 20000;
const MAX_TITLE_CHARS = 60;
const MAX_SEARCH_CHARS = 100;

router.use(requireAuth);

function normalizedTitle(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS) : "";
}

function escapedRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function conversationSnippet(conversation, query) {
  const needle = query.toLowerCase();
  const message = conversation.messages?.find(
    item => typeof item.content === "string" && item.content.toLowerCase().includes(needle)
  );
  if (!message) return "";
  const compact = message.content.replace(/\s+/g, " ").trim();
  const index = compact.toLowerCase().indexOf(needle);
  if (index < 0) return compact.slice(0, 160);
  const start = Math.max(0, index - 48);
  const end = Math.min(compact.length, index + needle.length + 96);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

function serializeMessage(message) {
  return {
    role: message.role,
    content: message.content,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.feedback ? { feedback: message.feedback } : {}),
    ...(Array.isArray(message.attachments) && message.attachments.length > 0
      ? { attachments: message.attachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, bytes: attachment.bytes })) }
      : {}),
    ...(Array.isArray(message.artifacts) && message.artifacts.length > 0
      ? {
          artifacts: message.artifacts.map(artifact => ({
            id: artifact.id,
            title: artifact.title,
            status: artifact.status,
            fileCount: artifact.fileCount,
            bytes: artifact.bytes
          }))
        }
      : {}),
    createdAt: message.createdAt
  };
}

function serializeConversation(conversation) {
  return {
    id: String(conversation._id),
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.map(serializeMessage)
  };
}

// Starts a persisted conversation from a bounded handoff before the user types
// anything, so the first model request in the new chat already carries context.
router.post("/", async (req, res, next) => {
  try {
    const handoff = typeof req.body?.handoff === "string" ? req.body.handoff.trim() : "";
    if (!handoff) {
      return res.status(400).json({ message: "A continuation summary is required." });
    }
    if (handoff.length > MAX_HANDOFF_CHARS) {
      return res.status(413).json({ message: "The continuation summary is too long." });
    }
    const requestedTitle =
      typeof req.body?.title === "string" ? req.body.title.replace(/\s+/g, " ").trim() : "";
    const title = (requestedTitle || "Continued chat").slice(0, MAX_TITLE_CHARS);
    await connectToDatabase();
    const conversation = await Conversation.create({
      userId: req.userId,
      title,
      messages: [{ role: "user", content: handoff }]
    });
    return res.status(201).json({ conversation: serializeConversation(conversation) });
  } catch (error) {
    return next(error);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const query = typeof req.query.q === "string" ? req.query.q.replace(/\s+/g, " ").trim() : "";
    if (query.length > MAX_SEARCH_CHARS) {
      return res.status(400).json({ message: `Search terms must be ${MAX_SEARCH_CHARS} characters or fewer.` });
    }
    await connectToDatabase();
    const filter = query
      ? {
          userId: req.userId,
          $or: [
            { title: { $regex: escapedRegex(query), $options: "i" } },
            { "messages.content": { $regex: escapedRegex(query), $options: "i" } }
          ]
        }
      : { userId: req.userId };
    const conversations = await Conversation.find(filter)
      .select("title createdAt updatedAt messages")
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();
    return res.json({
      conversations: conversations.map(conversation => ({
        id: String(conversation._id),
        title: conversation.title,
        messageCount: conversation.messages?.length ?? 0,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        ...(query ? { match: conversationSnippet(conversation, query) } : {})
      }))
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid conversation ID." });
    }
    const title = normalizedTitle(req.body?.title);
    if (!title) return res.status(400).json({ message: "Enter a task title." });
    await connectToDatabase();
    const conversation = await Conversation.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { $set: { title } },
      { returnDocument: "after", projection: "title createdAt updatedAt messages" }
    ).lean();
    if (!conversation) return res.status(404).json({ message: "Conversation not found." });
    return res.json({
      conversation: {
        id: String(conversation._id),
        title: conversation.title,
        messageCount: conversation.messages?.length ?? 0,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt
      }
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id/artifacts", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid conversation ID." });
    }
    await connectToDatabase();
    const conversation = await Conversation.findOne({ _id: req.params.id, userId: req.userId }).select("_id").lean();
    if (!conversation) return res.status(404).json({ message: "Conversation not found." });
    const artifacts = await Artifact.find({ userId: req.userId, conversationId: req.params.id })
      .sort({ createdAt: 1 })
      .lean();
    return res.json({
      artifacts: artifacts.map(artifact => ({
        id: String(artifact._id),
        messageId: artifact.messageId,
        title: artifact.title,
        status: artifact.status,
        finishReason: artifact.finishReason,
        files: artifact.files.map(file => ({
          path: file.path,
          language: file.language,
          content: file.content,
          bytes: file.bytes,
          complete: file.complete !== false
        })),
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt
      }))
    });
  } catch (error) {
    return next(error);
  }
});

const FEEDBACK_VALUES = new Set(["like", "dislike"]);

// A reaction lives on the assistant message itself, so repeated clicks update
// the same record and can never create duplicates for one response.
router.put("/:id/messages/:messageId/feedback", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: "Conversation not found." });
    }
    const messageId = typeof req.params.messageId === "string" ? req.params.messageId.trim() : "";
    if (!messageId || messageId.length > 80) {
      return res.status(400).json({ message: "Invalid message ID." });
    }
    const value = req.body?.value ?? null;
    if (value !== null && !FEEDBACK_VALUES.has(value)) {
      return res.status(400).json({ message: "Feedback must be like, dislike, or null." });
    }
    await connectToDatabase();
    const conversation = await Conversation.findOne({
      _id: req.params.id,
      userId: req.userId
    }).select("messages");
    if (!conversation) return res.status(404).json({ message: "Conversation not found." });
    const message = conversation.messages.find(
      item => item.messageId === messageId && item.role === "assistant"
    );
    if (!message) return res.status(404).json({ message: "Message not found." });
    message.feedback = value === null ? undefined : value;
    await conversation.save();
    return res.json({ feedback: message.feedback ?? null });
  } catch (error) {
    return next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid conversation ID." });
    }
    await connectToDatabase();
    const conversation = await Conversation.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!conversation) return res.status(404).json({ message: "Conversation not found." });
    return res.json({ conversation: serializeConversation(conversation) });
  } catch (error) {
    return next(error);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid conversation ID." });
    }
    await connectToDatabase();
    const result = await Conversation.deleteOne({ _id: req.params.id, userId: req.userId });
    if (result.deletedCount === 0) return res.status(404).json({ message: "Conversation not found." });
    await Artifact.deleteMany({ userId: req.userId, conversationId: req.params.id });
    return res.json({ message: "Conversation deleted." });
  } catch (error) {
    return next(error);
  }
});

export default router;

