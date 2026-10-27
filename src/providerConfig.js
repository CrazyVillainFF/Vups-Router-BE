import crypto from "node:crypto";
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

// A saved configuration is identified by a stable configId — never by the
// provider name alone. The same provider can be configured multiple times
// (different keys, different models) without overwriting previous rows.
export function newConfigId() {
  return crypto.randomUUID();
}

const providerConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  configId: { type: String, required: true, trim: true, maxlength: 80, index: true },
  providerId: { type: String, required: true, trim: true, maxlength: 60, index: true },
  provider: { type: String, required: true, trim: true, maxlength: 80 },
  providerType: {
    type: String,
    enum: ["openai_compatible", "openai_responses", "anthropic_compatible", "azure_openai", "watsonx", "local_gateway", "native", "qoder_cloud_agents"],
    default: "openai_compatible"
  },
  baseUrl: { type: String, required: true, trim: true, maxlength: 500 },
  model: { type: String, trim: true, maxlength: 200, default: "" },
  models: { type: [String], default: [] },
  // Models whose zero price was verified from provider metadata during free
  // catalogue discovery. This lets the free picker route a model the user has
  // not explicitly saved, without trusting a client-supplied model ID.
  freeModels: { type: [String], default: [] },
  freeModelsAt: { type: Date, default: null },
  defaultModel: { type: String, trim: true, maxlength: 200, default: "" },
  enabled: { type: Boolean, default: true },
  active: { type: Boolean, default: false },
  encryptedApiKey: { type: String, required: true, select: false },
  lastTestStatus: { type: String, trim: true, maxlength: 40, default: "" },
  lastTestCode: { type: String, trim: true, maxlength: 60, default: "" },
  lastTestMessage: { type: String, trim: true, maxlength: 400, default: "" },
  lastTestAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

// configId is the row identity; providerId is only a descriptive slug and may
// repeat (two DeepSeek keys are two configurations).
providerConfigSchema.index({ userId: 1, configId: 1 }, { unique: true });
providerConfigSchema.index({ userId: 1, providerId: 1 });

const ProviderConfig = mongoose.models.ProviderConfig || mongoose.model("ProviderConfig", providerConfigSchema);

let indexesReady = null;

// Earlier deployments enforced one document per {userId, providerId}. That
// index must be removed so a user can keep several keys for the same provider.
// syncIndexes() drops indexes that are no longer in the schema and creates the
// new configId index. Runs once per process; failures are retried lazily.
export function ensureProviderIndexes() {
  if (!indexesReady) {
    indexesReady = ProviderConfig.syncIndexes()
      .catch(() => {
        indexesReady = null;
      });
  }
  return indexesReady;
}

export default ProviderConfig;
