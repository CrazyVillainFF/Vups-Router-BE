import mongoose from "mongoose";

// Attachment metadata only (name/type/size) — image bytes are never stored.
const attachmentSchema = new mongoose.Schema({
  name: { type: String, default: "", maxlength: 200 },
  mimeType: { type: String, required: true, maxlength: 80 },
  bytes: { type: Number, min: 0, default: 0 }
}, { _id: false });

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ["user", "assistant"], required: true },
  content: { type: String, default: "", maxlength: 32000 },
  attachments: { type: [attachmentSchema], default: undefined },
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
