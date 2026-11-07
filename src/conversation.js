import mongoose from "mongoose";
import { progressEventSchema } from "./taskRun.js";

// Attachment metadata only (name/type/size) — image bytes are never stored.
const attachmentSchema = new mongoose.Schema({
  name: { type: String, default: "", maxlength: 200 },
  mimeType: { type: String, required: true, maxlength: 80 },
  bytes: { type: Number, min: 0, default: 0 }
}, { _id: false });

const artifactRefSchema = new mongoose.Schema({
  id: { type: String, required: true, maxlength: 80 },
  title: { type: String, default: "", maxlength: 120 },
  status: { type: String, enum: ["partial", "complete"], default: "complete" },
  fileCount: { type: Number, min: 0, default: 0 },
  bytes: { type: Number, min: 0, default: 0 }
}, { _id: false });

const messageSchema = new mongoose.Schema({
  messageId: { type: String, maxlength: 80 },
  role: { type: String, enum: ["user", "assistant"], required: true },
  content: { type: String, default: "", maxlength: 100000 },
  status: { type: String, enum: ["completed", "interrupted", "failed"], default: "completed" },
  // Machine-readable reason for a turn that did not complete, so a reloaded
  // chat can show the same card the user saw live.
  errorCode: { type: String, maxlength: 60 },
  feedback: { type: String, enum: ["like", "dislike"], default: undefined },
  attachments: { type: [attachmentSchema], default: undefined },
  artifacts: { type: [artifactRefSchema], default: undefined },
  // The steps a desktop agent turn really ran, kept with the answer so a
  // reloaded chat shows what happened instead of only what it concluded.
  progress: { type: [progressEventSchema], default: undefined },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const conversationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  messages: { type: [messageSchema], default: [] }
}, { timestamps: true, versionKey: false });

conversationSchema.index({ userId: 1, updatedAt: -1 });

const Conversation = mongoose.models.Conversation || mongoose.model("Conversation", conversationSchema);

export default Conversation;
