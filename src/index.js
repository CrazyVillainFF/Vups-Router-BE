import "dotenv/config";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import mongoose from "mongoose";
import connectToDatabase, { describeDatabaseError, isDatabaseFailure, safeDatabaseErrorText } from "./db.js";
import authRoutes from "./routes/auth.js";
import desktopAuthRoutes from "./routes/desktopAuth.js";
import passwordResetRoutes from "./routes/passwordReset.js";
import settingsRoutes from "./routes/settings.js";
import conversationsRoutes from "./routes/conversations.js";
import chatRoutes from "./routes/chat.js";
import comboRoutes from "./routes/combo.js";
import imageRoutes from "./routes/images.js";
import adminRoutes from "./routes/admin.js";
import pluginRoutes from "./routes/plugins.js";
import taskRoutes from "./routes/tasks.js";
import internalRoutes from "./routes/internal.js";
import { runningTaskIds, startTaskWorker, stopTaskWorker } from "./taskWorker.js";
import {
  canRunTaskWorker,
  dispatchConfigured,
  serviceAuthConfigured,
  serviceRole,
  servesUserApi
} from "./serviceRole.js";
import { requireJsonBody, verifyOrigin } from "./middleware.js";
import { chatJsonBodyLimit } from "./chatImages.js";
import { emailProviderConfiguration } from "./email.js";
import { resetEmailDeliveryState } from "./resetDeliveryHealth.js";
import { vupsExecutionConfiguration, vupsTextConfiguration, vupsVisionConfiguration } from "./vupsGalax.js";

const app = express();
const port = Number(process.env.PORT || 4000);

// The role is decided before a single route is mounted, because what this process is allowed to do
// must not be something a request can change later.
function resolveRole() {
  try {
    return serviceRole();
  } catch (error) {
    if (process.env.NODE_ENV === "test") throw error;
    console.error(error.message);
    process.exit(1);
  }
}
const role = resolveRole();
const workerDisabled = process.env.TASK_WORKER_DISABLED === "1";
const workerEnabled = canRunTaskWorker(role) && !workerDisabled;

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
  const isChatRoute =
    req.path === "/api/chat" ||
    req.path.startsWith("/api/chat/") ||
    req.path === "/api/combo/chat" ||
    req.path.startsWith("/api/combo/chat/");
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
    const email = emailProviderConfiguration();
    const delivery = await resetEmailDeliveryState();
    return res.json({
      success: true,
      service: "VupsRouter",
      status: "online",
      database: "connected",
      environment: process.env.NODE_ENV || "development",
      release: (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || "unknown").slice(0, 40),
      // Which half of the job this process is, and whether it can see the other half. A deployed
      // role that cannot be read from outside is a role that cannot be verified, and these are
      // counts and words only: no url, no key, no identity.
      role,
      execution: {
        servesUserApi: servesUserApi(role),
        taskWorker: workerEnabled ? "enabled" : "disabled",
        tasksRunning: workerEnabled ? runningTaskIds().length : 0,
        internalEndpoint: !canRunTaskWorker(role)
          ? "absent"
          : serviceAuthConfigured() ? "protected" : "unconfigured",
        dispatch: dispatchConfigured() ? "configured" : "not_configured"
      },
      features: {
        // Presence-only: whether recovery email can work here and whether the
        // provider has been accepting sends. No values, addresses or keys.
        passwordResetEmail: email.configured ? "configured" : "missing_configuration",
        passwordResetEmailMissing: email.missing,
        passwordResetEmailDelivery: delivery.failing ? "failing" : "ok",
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
      role,
      reason,
      hint
    });
  }
});

app.get("/api", (_req, res) => res.json({
  success: true,
  service: "VupsRouter",
  role,
  message: servesUserApi(role)
    ? "VupsRouter API index. All application routes are served under /api/*."
    : "This service runs tasks and does not serve a browser.",
  health: "/api/health",
  routes: servesUserApi(role)
    ? ["/api/auth", "/api/forgot-password", "/api/verify-code", "/api/reset-password", "/api/settings", "/api/conversations", "/api/chat", "/api/tasks", "/api/images", "/api/plugins", "/api/admin"]
    : []
}));

// A runner serves no browser. Every user-facing mount sits behind this one decision, so a second
// deployment cannot be signed in to, cannot read a conversation, and cannot stand in as a copy of
// the API. What it does not mount answers 404 rather than 401, which is the honest answer for a
// route this role does not have.
if (servesUserApi(role)) {
  app.use("/api/auth/desktop", desktopAuthRoutes);
  app.use("/api/auth", authRoutes);
  app.use("/api", passwordResetRoutes);
  app.use("/api/settings", settingsRoutes);
  app.use("/api/conversations", conversationsRoutes);
  app.use("/api/chat", chatRoutes);
  app.use("/api/combo", comboRoutes);
  app.use("/api/images", imageRoutes);
  app.use("/api/plugins", pluginRoutes);
  app.use("/api/tasks", taskRoutes);
  app.use("/api/admin", adminRoutes);
}

// Only a process that may execute work has anything to answer here. The secret check lives in the
// router, so a role that cannot run tasks never exposes the path at all.
if (canRunTaskWorker(role)) {
  app.use("/api/internal", internalRoutes);
}

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
  const httpServer = app.listen(port, () => {
    console.log(`VupsRouter API listening on port ${port}`);
    // One line per start that names the environment, the role and whether password
    // recovery email can work here, so a deployed instance is never guessed at.
    const email = emailProviderConfiguration();
    console.log(
      `Role: ${role} (browser API ${servesUserApi(role) ? "on" : "off"}, task worker ${workerEnabled ? "on" : "off"})`
    );
    console.log(
      `Environment: NODE_ENV=${process.env.NODE_ENV || "unset"} · password recovery email ${
        email.configured ? "configured" : `not configured (missing ${email.missing.join(", ")})`
      }`
    );
  });

  // Tasks are run by the server, not by the request that submitted them, so the worker starts with
  // the process — unless this role only answers browsers, or a deployment has asked for the web and
  // the worker apart. Both switches are reported because a queue that nobody drains looks exactly
  // like a queue that is empty.
  let workerStarted = false;
  if (workerDisabled) {
    console.log(`Task worker disabled (TASK_WORKER_DISABLED=1); role=${role}.`);
  } else if (!canRunTaskWorker(role)) {
    console.log("Task worker not started: role=main accepts submissions, another role runs them.");
  } else {
    startTaskWorker();
    workerStarted = true;
  }

  // A platform stop is not a reason to lose work: give the running tasks back to
  // the queue with their interruption recorded, so the next boot recovers them
  // instead of waiting for a lease to expire.
  let closing = false;
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      const finish = () => {
        httpServer.close(() => process.exit(0));
        // Never let a keep-alive connection hold the process past a shutdown.
        setTimeout(() => process.exit(0), 5000).unref();
      };
      if (workerStarted) stopTaskWorker().catch(() => {}).finally(finish);
      else finish();
    });
  }
}

export default app;
