import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";

export const DESKTOP_AUTH_TTL_MS = 10 * 60 * 1000;
export const DESKTOP_AUTH_CLIENTS = Object.freeze(["windows", "android", "web"]);

const desktopAuthSchema = new mongoose.Schema({
  ticketHash: { type: String, required: true, unique: true },
  challenge: { type: String, required: true },
  client: { type: String, enum: DESKTOP_AUTH_CLIENTS, default: "windows" },
  status: { type: String, enum: ["pending", "approved", "consumed"], default: "pending" },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  expiresAt: { type: Date, required: true }
}, { timestamps: true, versionKey: false });

// The TTL index is a cleanup backstop; every route also checks expiresAt so a
// document is rejected the moment it expires, not when Mongo evicts it.
desktopAuthSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const DesktopAuthRequest =
  mongoose.models.DesktopAuthRequest || mongoose.model("DesktopAuthRequest", desktopAuthSchema);

export default DesktopAuthRequest;

export function randomToken(size = 32) {
  return randomBytes(size).toString("base64url");
}

export function hashToken(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export function challengeForVerifier(verifier) {
  return hashToken(verifier);
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
