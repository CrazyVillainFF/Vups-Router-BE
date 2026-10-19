import crypto from "node:crypto";

export const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;

// The pepper is a dedicated server-side secret, separate from the Brevo API key.
export function passwordResetPepper() {
  const pepper = (process.env.PASSWORD_RESET_PEPPER || "").trim();
  return pepper.length >= 32 ? pepper : null;
}

export function generateResetToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashResetToken(rawToken) {
  const pepper = passwordResetPepper();
  if (!pepper) throw new Error("PASSWORD_RESET_PEPPER is not configured.");
  return crypto.createHmac("sha256", pepper).update(rawToken).digest("hex");
}

export function isValidResetTokenFormat(token) {
  return typeof token === "string" && RAW_TOKEN_PATTERN.test(token);
}
