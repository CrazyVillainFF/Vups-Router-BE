import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  email: { type: String, required: true, lowercase: true, trim: true, unique: true },
  passwordHash: { type: String, required: true, select: false },
  passwordChangedAt: { type: Date, default: null },
  resetCodeHash: { type: String, default: undefined, select: false },
  resetCodeExpires: { type: Date, default: undefined, select: false },
  resetAttempts: { type: Number, default: 0, select: false },
  resetAuthHash: { type: String, default: undefined, select: false },
  resetAuthExpires: { type: Date, default: undefined, select: false },
  aiEnabled: { type: Boolean, default: true },
  // Explicit model-picker preference. null means "not chosen yet"; the API
  // derives a safe default from the user's saved configurations so an existing
  // custom setup is never silently switched to the free catalogue.
  modelType: { type: String, enum: ["custom", "free", null], default: null },
  aiUsage: {
    day: { type: String, default: "" },
    count: { type: Number, default: 0 }
  }
}, { timestamps: true, versionKey: false });

const User = mongoose.models.User || mongoose.model("User", userSchema);

export default User;
