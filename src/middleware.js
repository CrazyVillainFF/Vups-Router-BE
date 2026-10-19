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
    const user = await User.findById(payload.sub).select("name email aiEnabled passwordChangedAt");
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ message: "Your account no longer exists. Please sign up again." });
    }
    if (user.passwordChangedAt && payload.iat && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
      clearSessionCookie(res);
      return res.status(401).json({ message: "Your password was changed. Please sign in again." });
    }
    req.user = user;
    req.userId = user.id;
    return next();
  } catch (error) {
    return next(error);
  }
}

export function requireAdmin(req, res, next) {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  const email = String(req.user?.email || "").toLowerCase();
  if (admins.length === 0 || !admins.includes(email)) {
    return res.status(403).json({ message: "Administrator access is required." });
  }
  return next();
}

export function verifyOrigin(allowed) {
  const isAllowed = typeof allowed === "function"
    ? allowed
    : origin => allowed.has(String(origin || "").replace(/\/+$/, ""));
  return function originGuard(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const origin = req.get("origin");
    if (!origin) return next();
    if (isAllowed(origin)) return next();
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

export const forgotPasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PASSWORD_RESET_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many password reset requests. Please wait 15 minutes and try again." }
});

export const verifyCodeRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.VERIFY_CODE_RATE_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many code verification attempts. Please wait 15 minutes and try again." }
});

export const resetPasswordRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.PASSWORD_RESET_ATTEMPT_LIMIT_MAX || 20),
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many password reset attempts. Please wait 15 minutes and try again." }
});
