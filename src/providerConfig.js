import mongoose from "mongoose";

export function providerIdFromName(name) {
  const slug = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "provider";
}

const providerConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  providerId: { type: String, required: true, trim: true, maxlength: 60 },
  provider: { type: String, required: true, trim: true, maxlength: 80 },
  providerType: {
    type: String,
    enum: ["openai_compatible", "anthropic_compatible", "native", "local_gateway"],
    default: "openai_compatible"
  },
  baseUrl: { type: String, required: true, trim: true, maxlength: 500 },
  model: { type: String, trim: true, maxlength: 200, default: "" },
  models: { type: [String], default: [] },
  defaultModel: { type: String, trim: true, maxlength: 200, default: "" },
  enabled: { type: Boolean, default: true },
  active: { type: Boolean, default: false },
  encryptedApiKey: { type: String, required: true, select: false },
  lastTestStatus: { type: String, trim: true, maxlength: 40, default: "" },
  lastTestCode: { type: String, trim: true, maxlength: 60, default: "" },
  lastTestMessage: { type: String, trim: true, maxlength: 400, default: "" },
  lastTestAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

providerConfigSchema.index({ userId: 1, providerId: 1 }, { unique: true });

const ProviderConfig = mongoose.models.ProviderConfig || mongoose.model("ProviderConfig", providerConfigSchema);

export default ProviderConfig;
