import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { SESSION_TTL_SECONDS } from "./session.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POLICY_VERSION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const TERMS_CONSENT_MESSAGE = "Accept the Terms of Service and Privacy Policy to create your account.";

export function isValidEmail(email) {
  return typeof email === "string" && EMAIL_PATTERN.test(email.trim()) && email.trim().length <= 254;
}

export function validateSignup({ name, email, password, acceptTerms }) {
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    return "Name must be between 2 and 80 characters.";
  }
  if (!isValidEmail(email)) {
    return "Enter a valid email address.";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return "Password must be between 8 and 128 characters.";
  }
  // Anything other than the literal true is a refusal: no default, no coercion.
  if (acceptTerms !== true) {
    return TERMS_CONSENT_MESSAGE;
  }
  return null;
}

export function consentPolicyVersion(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return POLICY_VERSION_PATTERN.test(text) ? text : null;
}

export function validateSignin({ email, password }) {
  if (!isValidEmail(email)) {
    return "Enter a valid email address.";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return "Enter a valid email and password.";
  }
  return null;
}

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function passwordMatches(password, hash) {
  return bcrypt.compare(password, hash);
}

export function createToken(user, secret) {
  return jwt.sign({ sub: String(user._id ?? user.id), email: user.email }, secret, {
    expiresIn: SESSION_TTL_SECONDS
  });
}
