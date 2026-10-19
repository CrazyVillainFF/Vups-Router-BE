import mongoose from "mongoose";

const appSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true, versionKey: false });

const AppSetting = mongoose.models.AppSetting || mongoose.model("AppSetting", appSettingSchema);

export default AppSetting;
