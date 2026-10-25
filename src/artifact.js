import mongoose from "mongoose";

const artifactFileSchema = new mongoose.Schema({
  path: { type: String, required: true, maxlength: 200 },
  language: { type: String, default: "", maxlength: 40 },
  content: { type: String, required: true, maxlength: 4_000_000 },
  bytes: { type: Number, min: 0, default: 0 },
  complete: { type: Boolean, default: true }
}, { _id: false });

const artifactSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
  messageId: { type: String, required: true, maxlength: 80 },
  title: { type: String, default: "Generated code", maxlength: 120 },
  status: { type: String, enum: ["partial", "complete"], default: "complete" },
  finishReason: { type: String, default: null, maxlength: 40 },
  files: { type: [artifactFileSchema], default: [] }
}, { timestamps: true, versionKey: false });

artifactSchema.index({ conversationId: 1, messageId: 1 }, { unique: true });
artifactSchema.index({ userId: 1, createdAt: -1 });

const Artifact = mongoose.models.Artifact || mongoose.model("Artifact", artifactSchema);

export default Artifact;
