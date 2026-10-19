import crypto from "node:crypto";

// Password recovery helpers for the six-digit email OTP flow.
//
// The OTP itself is hashed with bcrypt (same mechanism as passwords) before
// it is stored. The short-lived reset authorization issued after a successful
// code verification is a 256-bit random token that is only ever stored as a
// SHA-256 digest, so a database leak cannot be replayed against the API.

export const RESET_CODE_TTL_MS = 10 * 60 * 1000;
export const RESET_AUTH_TTL_MS = 10 * 60 * 1000;
export const RESET_MAX_ATTEMPTS = 5;

const CODE_PATTERN = /^\d{6}$/;
const AUTH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Always a six-character string so codes like 004213 keep their leading zeroes.
export function formatOtp(value) {
  return String(value).padStart(6, "0");
}

export function generateOtp() {
  return formatOtp(crypto.randomInt(0, 1_000_000));
}

export function isSixDigitCode(value) {
  return typeof value === "string" && CODE_PATTERN.test(value.trim());
}

export function generateResetAuthToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashResetAuthToken(rawToken) {
  return crypto.createHash("sha256").update(String(rawToken)).digest("hex");
}

export function isResetAuthTokenFormat(value) {
  return typeof value === "string" && AUTH_TOKEN_PATTERN.test(value.trim());
}
