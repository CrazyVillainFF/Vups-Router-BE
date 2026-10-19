import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import User from "./user.js";

export const SESSION_COOKIE = "vr_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isProduction() {
  return process.env.NODE_ENV === "production";
}

export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "test") return "test-jwt-secret-with-at-least-32-characters";
  return null;
}

export function sessionCookieOptions() {
  const production = isProduction();
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? "none" : "lax",
    partitioned: production,
    path: "/",
    maxAge: SESSION_TTL_MS
  };
}

export function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
}

export function extractBearerToken(req) {
  const header = req.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : null;
}

export async function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE] || extractBearerToken(req);
  if (!token) return res.status(401).json({ message: "Sign in to continue." });
  const secret = getJwtSecret();
  if (!secret) return res.status(500).json({ message: "Authentication is not configured on the server." });
  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    clearSessionCookie(res);
    return res.status(401).json({ message: "Your session expired. Please sign in again." });
  }
  try {
    const user = await User.findById(payload.sub).select("name email");
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ message: "Your account no longer exists. Please sign up again." });
    }
    req.user = user;
    req.userId = user.id;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function verifyOrigin(allowedOrigins) {
  return function originGuard(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (!origin) return next();
    if (allowedOrigins.has(origin)) return next();
    return res.status(403).json({ message: "Request blocked: origin not allowed." });
  };
}

export function requireJsonBody(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const length = Number(req.get("content-length") || 0);
  const transfer = req.get("transfer-encoding");
  if (length === 0 && !transfer) return next();
  const type = req.get("content-type") || "";
  if (type.toLowerCase().startsWith("application/json")) return next();
  return res.status(415).json({ message: "Requests must use application/json." });
}

function rateLimitOptions(defaultLimit, message) {
  return {
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.RATE_LIMIT_MAX || defaultLimit),
    standardHeaders: true,
    legacyHeaders: false,
    message: { message }
  };
}

export const authRateLimiter = rateLimit(
  rateLimitOptions(30, "Too many authentication attempts. Please wait 15 minutes and try again.")
);

export const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.CHAT_RATE_LIMIT_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many chat requests. Please slow down and try again shortly." }
});

export const settingsRateLimiter = rateLimit(
  rateLimitOptions(60, "Too many settings requests. Please wait and try again.")
);
