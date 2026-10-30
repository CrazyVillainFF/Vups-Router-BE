import dotenv from "dotenv";
import mongoose from "mongoose";
import { fileURLToPath } from "node:url";

dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const { default: connectToDatabase } = await import("../src/db.js");
const { default: User } = await import("../src/user.js");
const { default: ProviderConfig } = await import("../src/providerConfig.js");
const { default: PluginInstallation } = await import("../src/plugins/installation.js");
const { default: Conversation } = await import("../src/conversation.js");

await connectToDatabase();

const patterns = ["vishnubngaru001@gmial.com", "vishnubngaru001@gmail.com"];
const users = await User.find({ email: { $in: patterns } }).lean();
const fuzzy = await User.find({ email: /vishnubngaru001/i }).lean();

const rows = [];
for (const user of fuzzy) {
  const providers = await ProviderConfig.find({ userId: user._id }).lean();
  const plugins = await PluginInstallation.find({ userId: user._id }).lean();
  const conversations = await Conversation.countDocuments({ userId: user._id });
  rows.push({
    id: String(user._id),
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    aiEnabled: user.aiEnabled,
    modelType: user.modelType,
    aiUsage: user.aiUsage,
    passwordChangedAt: user.passwordChangedAt || null,
    counts: { providers: providers.length, plugins: plugins.length, conversations },
    providers: providers.map(p => ({
      configId: p.configId,
      providerId: p.providerId,
      provider: p.provider,
      providerType: p.providerType,
      baseUrl: p.baseUrl,
      authMode: p.authMode,
      openapiBaseUrl: p.openapiBaseUrl,
      model: p.model,
      models: p.models,
      defaultModel: p.defaultModel,
      enabled: p.enabled,
      active: p.active,
      hasApiKey: Boolean(p.encryptedApiKey),
      lastTestStatus: p.lastTestStatus,
      lastTestCode: p.lastTestCode,
      lastTestMessage: p.lastTestMessage,
      lastTestAt: p.lastTestAt,
      updatedAt: p.updatedAt
    })),
    plugins: plugins.map(p => ({
      pluginId: p.pluginId,
      status: p.status,
      config: p.config,
      credentialKeys: p.credentialKeys,
      connectedAt: p.connectedAt,
      lastTestAt: p.lastTestAt,
      lastTestStatus: p.lastTestStatus,
      lastTestMessage: p.lastTestMessage,
      lastError: p.lastError
    }))
  });
}

console.log(JSON.stringify({ exactMatches: users.map(u => u.email), rows }, null, 2));
await mongoose.disconnect();
