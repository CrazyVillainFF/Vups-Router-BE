import { Router } from "express";
import mongoose from "mongoose";
import connectToDatabase from "../db.js";
import Conversation from "../conversation.js";
import { requireAuth } from "../middleware.js";

const router = Router();

router.use(requireAuth);

router.get("/", async (req, res, next) => {
  try {
    await connectToDatabase();
    const conversations = await Conversation.find({ userId: req.userId })
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
        updatedAt: conversation.updatedAt
      }))
    });
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
    return res.json({
      conversation: {
        id: String(conversation._id),
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messages: conversation.messages.map(message => ({
          role: message.role,
          content: message.content,
          ...(Array.isArray(message.attachments) && message.attachments.length > 0
            ? { attachments: message.attachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, bytes: attachment.bytes })) }
            : {}),
          createdAt: message.createdAt
        }))
      }
    });
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
    return res.json({ message: "Conversation deleted." });
  } catch (error) {
    return next(error);
  }
});

export default router;
