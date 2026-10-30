import dotenv from "dotenv";
import mongoose from "mongoose";
import { fileURLToPath } from "node:url";
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
const { default: connectToDatabase } = await import("../src/db.js");
const { default: User } = await import("../src/user.js");
const { default: ProviderConfig } = await import("../src/providerConfig.js");
const { default: PluginInstallation } = await import("../src/plugins/installation.js");
const { default: Conversation } = await import("../src/conversation.js");
const { default: PluginAudit } = await import("../src/plugins/audit.js");
await connectToDatabase();
const users = await User.find({ email: { $in: ["vishnubangaru001@gmail.com", "vishnubangaru003@gmail.com"] } }).lean();
const out = [];
for (const u of users) {
  const providers = await ProviderConfig.find({ userId: u._id }).lean();
  const plugins = await PluginInstallation.find({ userId: u._id }).lean();
  const audit = await PluginAudit.find({ userId: u._id }).sort({ createdAt: -1 }).limit(20).lean();
  out.push({
    id: String(u._id), name: u.name, email: u.email, createdAt: u.createdAt, aiEnabled: u.aiEnabled, modelType: u.modelType, aiUsage: u.aiUsage,
    counts: { providers: providers.length, plugins: plugins.length, conversations: await Conversation.countDocuments({ userId: u._id }) },
    providers: providers.map(p => ({ configId: p.configId, providerId: p.providerId, provider: p.provider, providerType: p.providerType, baseUrl: p.baseUrl, authMode: p.authMode, openapiBaseUrl: p.openapiBaseUrl, model: p.model, models: p.models, defaultModel: p.defaultModel, enabled: p.enabled, active: p.active, hasApiKey: Boolean(p.encryptedApiKey), lastTestStatus: p.lastTestStatus, lastTestCode: p.lastTestCode, lastTestMessage: p.lastTestMessage, lastTestAt: p.lastTestAt, updatedAt: p.updatedAt })),
    plugins: plugins.map(p => ({ pluginId: p.pluginId, status: p.status, config: p.config, credentialKeys: p.credentialKeys, connectedAt: p.connectedAt, lastTestAt: p.lastTestAt, lastTestStatus: p.lastTestStatus, lastTestMessage: p.lastTestMessage, lastError: p.lastError })),
    recentPluginAudit: audit.map(a => ({ pluginId: a.pluginId, action: a.action, status: a.status, toolName: a.toolName, errorCode: a.errorCode, createdAt: a.createdAt }))
  });
}
console.log(JSON.stringify(out, null, 2));
await mongoose.disconnect();
