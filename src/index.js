import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import mongoose from "mongoose";
import connectToDatabase, { describeDatabaseError } from "./db.js";
import authRoutes from "./routes/auth.js";
import settingsRoutes from "./routes/settings.js";
import conversationsRoutes from "./routes/conversations.js";
import chatRoutes from "./routes/chat.js";
import { requireJsonBody, verifyOrigin } from "./middleware.js";

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

const configuredOrigins = [process.env.CLIENT_ORIGIN, process.env.CLIENT_ORIGINS]
  .filter(Boolean)
  .flatMap(value => value.split(","))
  .map(origin => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://vups-router-three.vercel.app",
  ...configuredOrigins
]);

if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/+$/, ""))) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS."));
  },
  credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: "512kb" }));
app.use(requireJsonBody);
app.use(verifyOrigin(allowedOrigins));

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
    return res.json({
      success: true,
      service: "VupsRouter",
      status: "online",
      database: "connected"
    });
  } catch (error) {
    const { reason, hint } = describeDatabaseError(error);
    console.error("Health check failed:", error?.name || "UnknownError", reason);
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

app.use("/api/auth", authRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/conversations", conversationsRoutes);
app.use("/api/chat", chatRoutes);

app.use((_req, res) => {
  return res.status(404).json({ message: "That API route does not exist." });
});

app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const name = error?.name || "UnknownError";
  if (error?.message === "Database is not configured.") {
    console.error("Database configuration missing.");
    return res.status(503).json({
      message: "The database is not configured on the server. Set MONGODB_URI.",
      ...describeDatabaseError(error)
    });
  }
  if (/Mongoose|MongoServer|MongoNetwork|MongoTopology/i.test(name)) {
    const { reason, hint } = describeDatabaseError(error);
    console.error("Database request failed:", name, reason);
    return res.status(503).json({
      message: "The database is unavailable right now. Please try again shortly.",
      reason,
      hint
    });
  }
  if (name === "ValidationError") {
    return res.status(400).json({ message: "The submitted data is invalid." });
  }
  if (name === "Error" && /Origin not allowed/i.test(error?.message || "")) {
    return res.status(403).json({ message: "Request blocked: origin not allowed." });
  }
  console.error("API request failed:", name);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
});

if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => console.log(`VupsRouter API listening on port ${port}`));
}

export default app;
