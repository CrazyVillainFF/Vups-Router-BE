import mongoose from "mongoose";

const providerConfigSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  provider: { type: String, required: true, trim: true, maxlength: 80 },
  baseUrl: { type: String, required: true, trim: true, maxlength: 500 },
  model: { type: String, trim: true, maxlength: 200, default: "" },
  encryptedApiKey: { type: String, required: true, select: false },
  lastTestStatus: { type: String, trim: true, maxlength: 40, default: "" },
  lastTestCode: { type: String, trim: true, maxlength: 60, default: "" },
  lastTestMessage: { type: String, trim: true, maxlength: 400, default: "" },
  lastTestAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

const ProviderConfig = mongoose.models.ProviderConfig || mongoose.model("ProviderConfig", providerConfigSchema);

export default ProviderConfig;
