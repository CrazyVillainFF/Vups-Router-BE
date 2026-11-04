import mongoose from "mongoose";

// A sign-in attempt may only be redeemed once. The record is created when the
// provider authorize URL is built and deleted atomically when the callback claims
// it, so a replayed, expired, or never-issued state has nothing left to redeem.
const pluginOAuthStateSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  pluginId: { type: String, required: true, maxlength: 80 },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true }
}, { versionKey: false });

pluginOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const PluginOAuthState = mongoose.models.PluginOAuthState
  || mongoose.model("PluginOAuthState", pluginOAuthStateSchema);

export default PluginOAuthState;
