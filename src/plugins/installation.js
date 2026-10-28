import mongoose from "mongoose";

const pluginInstallationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  pluginId: { type: String, required: true, trim: true, maxlength: 80, index: true },
  status: {
    type: String,
    enum: ["connected", "needs_reconnection", "error", "disabled"],
    default: "connected",
    index: true
  },
  config: { type: mongoose.Schema.Types.Mixed, default: {} },
  credentialKeys: { type: [String], default: [] },
  encryptedCredentials: { type: String, default: "", select: false },
  connectedAt: { type: Date, default: Date.now },
  lastTestAt: { type: Date, default: null },
  lastTestStatus: { type: String, trim: true, maxlength: 40, default: "" },
  lastTestMessage: { type: String, trim: true, maxlength: 400, default: "" },
  lastError: { type: String, trim: true, maxlength: 400, default: "" }
}, { timestamps: true, versionKey: false });

pluginInstallationSchema.index({ userId: 1, pluginId: 1 }, { unique: true });

const PluginInstallation = mongoose.models.PluginInstallation
  || mongoose.model("PluginInstallation", pluginInstallationSchema);

export default PluginInstallation;
