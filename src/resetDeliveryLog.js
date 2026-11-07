import mongoose from "mongoose";

// One document per email provider, recording the outcome of the most recent
// password-reset delivery attempt. It stores machine-readable outcome codes
// only — never a recipient address, an OTP, a message body or an API key — so
// the collection is safe to read from the health endpoint and to keep.
const resetDeliverySchema = new mongoose.Schema({
  provider: { type: String, required: true, unique: true },
  lastOutcome: { type: String, enum: ["sent", "failed"], default: null },
  lastFailureCode: { type: String, default: null },
  lastFailureAt: { type: Date, default: null },
  lastSuccessAt: { type: Date, default: null },
  // The provider's own receipt for the last accepted send. It identifies the
  // message inside the provider account so a later bounce or complaint can be
  // looked up; it is not a credential and never contains the code.
  lastMessageId: { type: String, default: null }
}, { timestamps: true, versionKey: false });

const ResetDelivery = mongoose.models.ResetDelivery || mongoose.model("ResetDelivery", resetDeliverySchema);

export default ResetDelivery;
