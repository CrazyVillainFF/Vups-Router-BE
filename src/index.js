import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import mongoose from "mongoose";
import connectToDatabase, { describeDatabaseError, isDatabaseFailure, safeDatabaseErrorText } from "./db.js";
import authRoutes from "./routes/auth.js";
import passwordResetRoutes from "./routes/passwordReset.js";
import settingsRoutes from "./routes/settings.js";
import conversationsRoutes from "./routes/conversations.js";
import chatRoutes from "./routes/chat.js";
import imageRoutes from "./routes/images.js";
import adminRoutes from "./routes/admin.js";
import { requireJsonBody, verifyOrigin } from "./middleware.js";
import { chatJsonBodyLimit } from "./chatImages.js";
import { vupsExecutionConfiguration, vupsTextConfiguration, vupsVisionConfiguration } from "./vupsGalax.js";

const app = express();
const port = Number(process.env.PORT || 4000);

if (process.env.NODE_ENV !== "test") {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error("JWT_SECRET must be set to a random secret of at least 32 characters.");
    process.exit(1);
  }
  if (!process.env.ENCRYPTION_SECRET || process.env.ENCRYPTION_SECRET.length < 32) {
    console.error("ENCRYPTION_SECRET must be set to a random secret of at least 32 characters.");
    process.exit(1);
  }
}

const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "https://vups-router-three.vercel.app"
];

function originPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[a-z0-9-]+");
  return new RegExp(`^${escaped}$`, "i");
}

function currentOriginPolicy() {
  const configured = [
    process.env.CLIENT_ORIGIN,
    process.env.CLIENT_ORIGINS,
    process.env.FRONTEND_ORIGIN,
    process.env.FRONTEND_ORIGINS
  ]
    .filter(Boolean)
    .flatMap(value => value.split(","))
    .map(origin => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const patterns = [process.env.CLIENT_ORIGIN_PATTERNS, process.env.FRONTEND_ORIGIN_PATTERNS]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map(value => value.trim().replace(/\/+$/, ""))
    .filter(value => value.includes("*"))
    .map(originPatternToRegExp);
  return { exact: new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]), patterns };
}

function originAllowed(origin) {
  const normalized = String(origin || "").trim().replace(/\/+$/, "");
  if (!normalized) return false;
  const { exact, patterns } = currentOriginPolicy();
  return exact.has(normalized) || patterns.some(pattern => pattern.test(normalized));
}

export function resolveTrustProxy(value = process.env.TRUST_PROXY) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return process.env.NODE_ENV === "production" ? 1 : false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

app.set("trust proxy", resolveTrustProxy());

app.disable("x-powered-by");
app.use((req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  next();
});
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || originAllowed(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS."));
  },
  credentials: true
}));
app.use(cookieParser());
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
// Chat requests can carry base64 image attachments; every other route keeps
// the small JSON limit. The chat limit is derived from the image limits in
// chatImages.js (base64 inflates decoded bytes by ~4/3).
const defaultJsonParser = express.json({ limit: "512kb" });
const chatJsonParser = express.json({ limit: chatJsonBodyLimit() });
app.use((req, res, next) => {
  const isChatRoute = req.path === "/api/chat" || req.path.startsWith("/api/chat/");
  return (isChatRoute ? chatJsonParser : defaultJsonParser)(req, res, next);
});
app.use(requireJsonBody);
app.use(verifyOrigin(originAllowed));

app.get("/", (_req, res) => res.json({
  success: true,
  message: "VupsRouter Backend API is running",
  service: "VupsRouter",
  status: "online"
}));

app.get("/api/health", async (_req, res) => {
  try {
    await connectToDatabase();
    await mongoose.connection.db.admin().ping();
    const vision = vupsVisionConfiguration();
    const text = vupsTextConfiguration();
    const execution = vupsExecutionConfiguration();
    return res.json({
      success: true,
      service: "VupsRouter",
      status: "online",
      database: "connected",
      release: (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "unknown").slice(0, 40),
      features: {
        vupsRetry: true,
        vupsDiagnostics: true,
        vupsImageGeneration: vision.enabled,
        vupsVisionModel: vision.model,
        vupsVisionModelSource: vision.source,
        vupsTextModel: text.model,
        vupsTextModelSource: text.source,
        vupsMaxOutputTokens: execution.maxOutputTokens,
        vupsStreamStartTimeoutMs: execution.streamStartTimeoutMs,
        vupsStreamIdleTimeoutMs: execution.streamIdleTimeoutMs,
        vupsSseHeartbeatMs: execution.heartbeatMs
      }
    });
  } catch (error) {
    const { reason, hint } = describeDatabaseError(error);
    console.error("Health check failed:", reason, "|", safeDatabaseErrorText(error));
    return res.status(503).json({
      success: false,
      message: "Backend is running but MongoDB is unavailable",
      service: "VupsRouter",
      status: "degraded",
      database: "disconnected",
      reason,
      hint
    });
  }
});

app.get("/api", (_req, res) => res.json({
  success: true,
  service: "VupsRouter",
  message: "VupsRouter API index. All application routes are served under /api/*.",
  health: "/api/health",
  routes: ["/api/auth", "/api/forgot-password", "/api/verify-code", "/api/reset-password", "/api/settings", "/api/conversations", "/api/chat", "/api/images", "/api/admin"]
}));

app.use("/api/auth", authRoutes);
app.use("/api", passwordResetRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/conversations", conversationsRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/images", imageRoutes);
app.use("/api/admin", adminRoutes);

app.use((_req, res) => {
  return res.status(404).json({ message: "That API route does not exist." });
});

app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  const name = error?.name || "UnknownError";
  if (isDatabaseFailure(error)) {
    if (error?.message === "Database is not configured.") {
      console.error("Database configuration missing.");
      return res.status(503).json({
        message: "The database is not configured on the server. Set MONGODB_URI.",
        ...describeDatabaseError(error)
      });
    }
    const { reason, hint } = describeDatabaseError(error);
    console.error("Database request failed:", error?.name || "UnknownError", reason, "|", safeDatabaseErrorText(error));
    return res.status(503).json({
      message: "The database is unavailable right now. Please try again shortly.",
      reason,
      hint
    });
  }
  if (name === "ValidationError") {
    return res.status(400).json({ message: "The submitted data is invalid." });
  }
  if (name === "SyntaxError" && (error?.status === 400 || error?.statusCode === 400 || error?.type === "entity.parse.failed")) {
    return res.status(400).json({ message: "Request body must be valid JSON." });
  }
  if (name === "Error" && /Origin not allowed/i.test(error?.message || "")) {
    return res.status(403).json({ message: "Request blocked: origin not allowed." });
  }
  console.error("API request failed:", name, "| requestId:", req.requestId || "-");
  return res.status(500).json({ message: "Something went wrong. Please try again." });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`VupsRouter API listening on port ${port}`));
}

export default app;
