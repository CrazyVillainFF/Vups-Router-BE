import mongoose from "mongoose";

const pluginAuditSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  pluginId: { type: String, required: true, trim: true, maxlength: 80, index: true },
  action: {
    type: String,
    enum: ["install", "test", "update", "execute", "uninstall", "oauth_start", "oauth_callback"],
    required: true
  },
  toolName: { type: String, trim: true, maxlength: 80, default: "" },
  status: { type: String, enum: ["success", "error", "denied"], required: true },
  errorCode: { type: String, trim: true, maxlength: 80, default: "" },
  durationMs: { type: Number, min: 0, default: null },
  requestId: { type: String, trim: true, maxlength: 80, default: "" },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

pluginAuditSchema.index({ userId: 1, createdAt: -1 });
pluginAuditSchema.index({ userId: 1, pluginId: 1, createdAt: -1 });
pluginAuditSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const PluginAudit = mongoose.models.PluginAudit || mongoose.model("PluginAudit", pluginAuditSchema);

export default PluginAudit;
