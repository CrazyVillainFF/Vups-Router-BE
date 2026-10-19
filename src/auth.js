import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const TOKEN_TTL = "7d";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email) {
  return typeof email === "string" && EMAIL_PATTERN.test(email.trim()) && email.trim().length <= 254;
}

export function validateSignup({ name, email, password }) {
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 80) {
    return "Name must be between 2 and 80 characters.";
  }
  if (!isValidEmail(email)) {
    return "Enter a valid email address.";
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return "Password must be between 8 and 128 characters.";
  }
  return null;
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
  return jwt.sign({ sub: String(user._id ?? user.id), email: user.email }, secret, { expiresIn: TOKEN_TTL });
}
