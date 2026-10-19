import mongoose from "mongoose";

// One document per normalized email (stored as a sha256 hash — no plaintext
// emails), holding the timestamps of the reset codes requested in the current
// rolling window. MongoDB-backed so the limit survives restarts and applies
// across instances. See resetThrottle.js for the enforcement logic.
const resetSendLogSchema = new mongoose.Schema({
  emailHash: { type: String, required: true, unique: true },
  sends: { type: [Date], default: [] }
}, { timestamps: true, versionKey: false });

const ResetSendLog = mongoose.models.ResetSendLog || mongoose.model("ResetSendLog", resetSendLogSchema);

export default ResetSendLog;
